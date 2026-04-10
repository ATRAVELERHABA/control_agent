# .skills 目录说明

这个目录用于存放你赋予智能体的本地技能定义。

当前实现约定：

- 一个技能对应一个 `.json` 文件
- 后端会在每次模型请求前读取 `.skills` 目录
- `type = "prompt"` 的技能会被注入到 system prompt
- `type = "tool"` 的技能会被转换成模型可见的 function/tool schema

## 技能文件结构

```json
{
  "id": "unique-skill-id",
  "name": "技能名称",
  "description": "技能描述",
  "type": "prompt",
  "enabled": true,
  "instruction": "当该技能为 prompt 类型时，这里的内容会追加到 system prompt。"
}
```

工具型技能示例：

```json
{
  "id": "execute-terminal-command",
  "name": "终端命令执行",
  "description": "允许模型请求在本地终端执行命令",
  "type": "tool",
  "enabled": true,
  "tool": {
    "name": "execute_terminal_command",
    "description": "在用户的操作系统终端执行自定义指令",
    "requires_confirmation": true,
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "需要在用户本地终端执行的完整命令字符串"
        }
      },
      "required": ["command"],
      "additionalProperties": false
    }
  }
}
```

## 当前建议

- 把“行为约束、平台适配、业务规则”写成 `prompt` 技能
- 把“可调用能力”写成 `tool` 技能
- 如果你想暂时停用某个技能，可以把 `enabled` 改成 `false`
