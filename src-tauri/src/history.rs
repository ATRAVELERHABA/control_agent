use std::{fs, path::PathBuf};

use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

use crate::{
    logging::timestamp_ms,
    models::{
        AgentMode, AppendConversationMessagesRequest, ConversationMessageDto,
        ConversationMessagesRequest, ConversationSummary, CreateConversationRequest,
        DeleteConversationRequest,
    },
};

const HISTORY_DIR_NAME: &str = "history";
const HISTORY_DB_FILE_NAME: &str = "history.db";
const DEFAULT_CONVERSATION_TITLE: &str = "New conversation";
const MAX_TITLE_CHARS: usize = 48;
const MAX_PREVIEW_CHARS: usize = 120;

#[derive(Debug)]
struct HistoryPaths {
    root_dir: PathBuf,
    db_file: PathBuf,
}

fn history_paths(app: &AppHandle) -> Result<HistoryPaths, String> {
    let root_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join(HISTORY_DIR_NAME);

    Ok(HistoryPaths {
        db_file: root_dir.join(HISTORY_DB_FILE_NAME),
        root_dir,
    })
}

fn next_id(prefix: &str) -> String {
    let random_part = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect::<String>();

    format!("{prefix}-{}-{random_part}", timestamp_ms())
}

fn clip_text(text: &str, max_chars: usize) -> String {
    let flattened = text
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if flattened.chars().count() <= max_chars {
        flattened
    } else {
        let mut clipped = flattened.chars().take(max_chars).collect::<String>();
        clipped.push_str("...");
        clipped
    }
}

fn normalized_title(raw: Option<&str>) -> String {
    let fallback = DEFAULT_CONVERSATION_TITLE.to_string();
    let Some(raw) = raw else {
        return fallback;
    };

    let title = clip_text(raw.trim(), MAX_TITLE_CHARS);
    if title.is_empty() {
        fallback
    } else {
        title
    }
}

fn infer_title_from_messages(messages: &[ConversationMessageDto]) -> Option<String> {
    messages
        .iter()
        .find(|message| message.role == "user")
        .and_then(|message| message.content.as_deref())
        .map(|content| clip_text(content, MAX_TITLE_CHARS))
        .filter(|title| !title.is_empty())
}

fn infer_preview_from_messages(messages: &[ConversationMessageDto]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter(|message| matches!(message.role.as_str(), "user" | "assistant" | "tool"))
        .find_map(|message| message.content.as_deref())
        .map(|content| clip_text(content, MAX_PREVIEW_CHARS))
        .filter(|preview| !preview.is_empty())
}

fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let paths = history_paths(app)?;
    fs::create_dir_all(&paths.root_dir)
        .map_err(|error| format!("Failed to create history directory: {error}"))?;

    let connection = Connection::open(&paths.db_file)
        .map_err(|error| format!("Failed to open history database: {error}"))?;

    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                account_email TEXT NOT NULL,
                title TEXT NOT NULL,
                mode TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_preview TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_conversations_account_updated
                ON conversations(account_email, updated_at DESC);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                account_email TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                tool_call_id TEXT,
                tool_calls_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
                ON messages(conversation_id, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_messages_account_conversation
                ON messages(account_email, conversation_id);
            ",
        )
        .map_err(|error| format!("Failed to initialize history schema: {error}"))?;

    Ok(connection)
}

fn read_conversation_summary(
    connection: &Connection,
    account_email: &str,
    conversation_id: &str,
) -> Result<ConversationSummary, String> {
    connection
        .query_row(
            "
            SELECT
                c.id,
                c.title,
                c.mode,
                c.created_at,
                c.updated_at,
                c.last_preview,
                (
                    SELECT COUNT(1)
                    FROM messages m
                    WHERE m.conversation_id = c.id
                ) AS message_count
            FROM conversations c
            WHERE c.id = ?1 AND c.account_email = ?2
            ",
            params![conversation_id, account_email],
            |row| {
                let mode_raw: String = row.get(2)?;
                let message_count: i64 = row.get(6)?;

                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    mode: AgentMode::from_storage_value(&mode_raw),
                    created_at: row.get::<_, i64>(3)?.max(0) as u64,
                    updated_at: row.get::<_, i64>(4)?.max(0) as u64,
                    last_preview: row.get(5)?,
                    message_count: message_count.max(0) as u32,
                })
            },
        )
        .map_err(|error| format!("Failed to read conversation summary: {error}"))
}

pub(crate) fn list_conversation_summaries(
    app: &AppHandle,
    account_email: &str,
) -> Result<Vec<ConversationSummary>, String> {
    let connection = open_connection(app)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                c.id,
                c.title,
                c.mode,
                c.created_at,
                c.updated_at,
                c.last_preview,
                (
                    SELECT COUNT(1)
                    FROM messages m
                    WHERE m.conversation_id = c.id
                ) AS message_count
            FROM conversations c
            WHERE c.account_email = ?1
            ORDER BY c.updated_at DESC
            ",
        )
        .map_err(|error| format!("Failed to prepare history query: {error}"))?;

    let mut rows = statement
        .query(params![account_email])
        .map_err(|error| format!("Failed to execute history query: {error}"))?;

    let mut summaries = Vec::<ConversationSummary>::new();

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to iterate conversation rows: {error}"))?
    {
        let mode_raw: String = row
            .get(2)
            .map_err(|error| format!("Failed to decode conversation mode: {error}"))?;
        let message_count: i64 = row
            .get(6)
            .map_err(|error| format!("Failed to decode conversation message count: {error}"))?;

        summaries.push(ConversationSummary {
            id: row
                .get(0)
                .map_err(|error| format!("Failed to decode conversation id: {error}"))?,
            title: row
                .get(1)
                .map_err(|error| format!("Failed to decode conversation title: {error}"))?,
            mode: AgentMode::from_storage_value(&mode_raw),
            created_at: row
                .get::<_, i64>(3)
                .map_err(|error| format!("Failed to decode conversation created_at: {error}"))?
                .max(0) as u64,
            updated_at: row
                .get::<_, i64>(4)
                .map_err(|error| format!("Failed to decode conversation updated_at: {error}"))?
                .max(0) as u64,
            last_preview: row
                .get(5)
                .map_err(|error| format!("Failed to decode conversation preview: {error}"))?,
            message_count: message_count.max(0) as u32,
        });
    }

    Ok(summaries)
}

pub(crate) fn create_conversation(
    app: &AppHandle,
    account_email: &str,
    request: CreateConversationRequest,
) -> Result<ConversationSummary, String> {
    let connection = open_connection(app)?;
    let conversation_id = next_id("conv");
    let now = timestamp_ms() as u64;
    let title = normalized_title(request.title.as_deref());

    connection
        .execute(
            "
            INSERT INTO conversations (
                id,
                account_email,
                title,
                mode,
                created_at,
                updated_at,
                last_preview
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, '')
            ",
            params![
                conversation_id,
                account_email,
                title,
                request.mode.storage_value(),
                now,
                now
            ],
        )
        .map_err(|error| format!("Failed to create conversation: {error}"))?;

    read_conversation_summary(&connection, account_email, &conversation_id)
}

pub(crate) fn delete_conversation(
    app: &AppHandle,
    account_email: &str,
    request: DeleteConversationRequest,
) -> Result<(), String> {
    let connection = open_connection(app)?;

    let affected_rows = connection
        .execute(
            "
            DELETE FROM conversations
            WHERE id = ?1 AND account_email = ?2
            ",
            params![request.conversation_id, account_email],
        )
        .map_err(|error| format!("Failed to delete conversation: {error}"))?;

    if affected_rows == 0 {
        Err("Conversation not found.".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn get_conversation_messages(
    app: &AppHandle,
    account_email: &str,
    request: ConversationMessagesRequest,
) -> Result<Vec<ConversationMessageDto>, String> {
    let connection = open_connection(app)?;
    let conversation_exists = connection
        .query_row(
            "
            SELECT 1
            FROM conversations
            WHERE id = ?1 AND account_email = ?2
            ",
            params![request.conversation_id, account_email],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Failed to check conversation existence: {error}"))?
        .is_some();

    if !conversation_exists {
        return Err("Conversation not found.".to_string());
    }

    let mut statement = connection
        .prepare(
            "
            SELECT role, content, tool_call_id, tool_calls_json
            FROM messages
            WHERE conversation_id = ?1 AND account_email = ?2
            ORDER BY created_at ASC, rowid ASC
            ",
        )
        .map_err(|error| format!("Failed to prepare history message query: {error}"))?;

    let mut rows = statement
        .query(params![request.conversation_id, account_email])
        .map_err(|error| format!("Failed to execute history message query: {error}"))?;

    let mut messages = Vec::<ConversationMessageDto>::new();

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to iterate history message rows: {error}"))?
    {
        let role: String = row
            .get(0)
            .map_err(|error| format!("Failed to decode history role: {error}"))?;
        let content: Option<String> = row
            .get(1)
            .map_err(|error| format!("Failed to decode history content: {error}"))?;
        let tool_call_id: Option<String> = row
            .get(2)
            .map_err(|error| format!("Failed to decode history tool_call_id: {error}"))?;
        let tool_calls_json: Option<String> = row
            .get(3)
            .map_err(|error| format!("Failed to decode history tool_calls_json: {error}"))?;

        let tool_calls = match tool_calls_json {
            Some(value) if !value.trim().is_empty() => Some(
                serde_json::from_str(&value)
                    .map_err(|error| format!("Failed to parse history tool_calls JSON: {error}"))?,
            ),
            _ => None,
        };

        messages.push(ConversationMessageDto {
            role,
            content,
            tool_call_id,
            tool_calls,
        });
    }

    Ok(messages)
}

pub(crate) fn append_conversation_messages(
    app: &AppHandle,
    account_email: &str,
    request: AppendConversationMessagesRequest,
) -> Result<ConversationSummary, String> {
    if request.messages.is_empty() {
        let connection = open_connection(app)?;
        return read_conversation_summary(&connection, account_email, &request.conversation_id);
    }

    let mut connection = open_connection(app)?;
    let conversation_snapshot = connection
        .query_row(
            "
            SELECT title, mode, last_preview
            FROM conversations
            WHERE id = ?1 AND account_email = ?2
            ",
            params![request.conversation_id, account_email],
            |row| {
                let title: String = row.get(0)?;
                let mode_raw: String = row.get(1)?;
                let last_preview: String = row.get(2)?;
                Ok((title, mode_raw, last_preview))
            },
        )
        .optional()
        .map_err(|error| format!("Failed to read target conversation: {error}"))?;

    let Some((existing_title, existing_mode_raw, existing_preview)) = conversation_snapshot else {
        return Err("Conversation not found.".to_string());
    };

    let mut title = existing_title;
    if title.trim().is_empty() {
        if let Some(inferred_title) = infer_title_from_messages(&request.messages) {
            title = inferred_title;
        }
    }

    if title.trim().is_empty() {
        title = DEFAULT_CONVERSATION_TITLE.to_string();
    }

    let preview =
        infer_preview_from_messages(&request.messages).unwrap_or_else(|| existing_preview.clone());
    let mode = request
        .mode
        .unwrap_or_else(|| AgentMode::from_storage_value(&existing_mode_raw));
    let now = timestamp_ms() as u64;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start history transaction: {error}"))?;

    for (index, message) in request.messages.iter().enumerate() {
        let message_id = next_id("msg");
        let created_at = now + index as u64;
        let tool_calls_json = match &message.tool_calls {
            Some(tool_calls) => Some(
                serde_json::to_string(tool_calls)
                    .map_err(|error| format!("Failed to serialize history tool_calls: {error}"))?,
            ),
            None => None,
        };

        transaction
            .execute(
                "
                INSERT INTO messages (
                    id,
                    conversation_id,
                    account_email,
                    role,
                    content,
                    tool_call_id,
                    tool_calls_json,
                    created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    message_id,
                    request.conversation_id,
                    account_email,
                    message.role,
                    message.content,
                    message.tool_call_id,
                    tool_calls_json,
                    created_at
                ],
            )
            .map_err(|error| format!("Failed to insert history message: {error}"))?;
    }

    transaction
        .execute(
            "
            UPDATE conversations
            SET
                title = ?1,
                mode = ?2,
                updated_at = ?3,
                last_preview = ?4
            WHERE id = ?5 AND account_email = ?6
            ",
            params![
                normalized_title(Some(&title)),
                mode.storage_value(),
                now,
                preview,
                request.conversation_id,
                account_email
            ],
        )
        .map_err(|error| format!("Failed to update history conversation metadata: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit history transaction: {error}"))?;

    read_conversation_summary(&connection, account_email, &request.conversation_id)
}
