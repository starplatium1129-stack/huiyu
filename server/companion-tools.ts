'use strict';

/**
 * 桌宠本地工具（Companion Tools）——服务端唯一权威定义。
 *
 * 网关在对话请求启用 companionTools 时，把这些 function schema 附加到
 * 上游 LLM 请求；流式响应中的 tool_calls 增量由 chat.js 解析为
 * `{ type:'tool-call', ... }` NDJSON 事件，由渲染端经桌面桥执行
 * （routes/desktop-tools.js，Tauri 壳走 /api/desktop-tools）。路径全部限制在 AI 工作区内。
 */

let TOOL_DEFINITIONS = [
  {
    type:'function',
    function:{
      name:'list_files',
      description:'列出 AI 工作区（AI_WORKSPACE_ROOT）内某个目录的内容。参数 path 为空表示工作区根目录；只读操作。',
      parameters:{
        type:'object',
        properties:{
          path:{ type:'string', description:'工作区内的相对路径，如 "SceneShowcase" 或 ""。禁止 .. 与绝对路径。' }
        },
        required:['path']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'read_file',
      description:'读取 AI 工作区内一个文本文件的内容（UTF-8，最大 1MB）。用于查看场景数据、脚本、配置等。',
      parameters:{
        type:'object',
        properties:{
          path:{ type:'string', description:'工作区内的相对文件路径，如 "data/scenes.json"。禁止 .. 与绝对路径。' }
        },
        required:['path']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'write_file',
      description:'在 AI 工作区内写入或覆盖一个文本文件（UTF-8，最大 512KB）。目录不存在会自动创建。用于保存脚本、笔记或修改配置。',
      parameters:{
        type:'object',
        properties:{
          path:{ type:'string', description:'工作区内的相对文件路径，如 "companion-notes/idea.md"。禁止 .. 与绝对路径。' },
          content:{ type:'string', description:'要写入的完整文本内容（覆盖写入）。' }
        },
        required:['path','content']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'run_command',
      description:'仅在操作员启用 trusted 命令档后执行本地命令。进程以 AI 工作区为起点，但具有当前系统账户权限，并非文件沙箱；参数数组传递，120 秒超时。未启用时应如实告知，不可通过文件工具绕过。',
      parameters:{
        type:'object',
        properties:{
          command:{ type:'string', description:'可执行文件，如 "python"、"git"、"node"，或工作区内脚本的相对路径。' },
          args:{ type:'array', items:{ type:'string' }, description:'命令参数列表，例如 ["--version"]。' }
        },
        required:['command','args']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'read_image',
      description:'读取 AI 工作区内一张图片（PNG/JPEG/WebP/GIF，最大 8MB）并理解其内容。需要当前对话模型支持视觉输入（Gemini/Claude 等）；纯文本模型会失败。',
      parameters:{
        type:'object',
        properties:{
          path:{ type:'string', description:'工作区内的相对图片路径，如 "samples/preview.png"。禁止 .. 与绝对路径。' }
        },
        required:['path']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'get_workspace_info',
      description:'返回 AI 工作区根目录的绝对路径与是否可访问。用于确认文件操作的范围。',
      parameters:{ type:'object', properties:{} }
    }
  },
  {
    type:'function',
    function:{
      name:'capture_screen',
      description:'截取用户当前 Windows 桌面主屏幕画面并返回 JPEG DataURL。用于看屏锐评、视觉感知与桌面辅助。',
      parameters:{ type:'object', properties:{} }
    }
  },
  {
    type:'function',
    function:{
      name:'generate_character_image',
      description:'根据角色名与场景描述保存绘画草稿，宁宁与夏目会附带专属 LoRA 配置。当前只准备草稿，不调用绘画引擎、不提交生成任务，也不返回图片；需用户在工作台确认后出图。不得宣称图片已生成。',
      parameters:{
        type:'object',
        properties:{
          character:{ type:'string', description:'角色 ID，如 "natsume"（四季夏目）、"nene"（绫地宁宁）或热门角色 ID。' },
          description:{ type:'string', description:'画面场景、动作、光影或剧情氛围的自然语言描述（如 "在海边喝汽水，微风吹拂，夏日清凉"）。' },
          outfit:{ type:'string', description:'服装类型（可选，如 "default"、"maid"、"swimsuit"、"casual"）。注意："nsfw_nude" 仅在本机成人内容授权开启且角色在成人白名单时可用，未授权会被拒绝。' },
          mature:{ type:'boolean', description:'是否为 R18 私密/成人画面（可选，缺省 false）。同样受本机成人授权与角色白名单双重门控，未授权会被拒绝并应改用普通服装重试。' }
        },
        required:['character','description']
      }
    }
  }
];

let TOOL_NAMES = Object.create(null);
TOOL_DEFINITIONS.forEach(function (definition) { TOOL_NAMES[definition.function.name] = true; });

function isKnownToolName(name: string|number) {
  return TOOL_NAMES[name] === true;
}

export = {
  TOOL_DEFINITIONS:TOOL_DEFINITIONS,
  isKnownToolName:isKnownToolName
};
