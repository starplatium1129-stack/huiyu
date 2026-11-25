use serde_json::{Value, json};
use std::sync::LazyLock;

static TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let mut tools: Vec<Value> = serde_json::from_str(include_str!("../tools.json")).unwrap();
    tools.push(
        serde_json::from_str(include_str!(
            "../../../../tools/cli-anything-huiyu/tool.json"
        ))
        .unwrap(),
    );
    tools
});

static CHANNEL_DRAWING_TOOLS: LazyLock<[Value; 2]> = LazyLock::new(|| {
    [
        json!({
            "type": "function",
            "function": {
                "name": "get_drawing_options",
                "description": "查当前桌面机实际装好的绘图模型、支持的画幅和自定义宽高范围、目录配方兼容性、默认采样和可用 LoRA。用户指定比例、分辨率、模型、LoRA 或高级采样时先核对。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "modelId": {"type":"string","description":"可选。省略则列出已安装绘图模型。"},
                        "character": {"type":"string","description":"可选。已知角色 ID，用于查询其实际可用的默认 LoRA。"}
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_drawing_catalog_item",
                "description": "查看一个角色、场景、蓝图或服装的详情。角色给出身份标签和外观，场景与蓝图给出种子和推荐画幅，服装给出配方和兼容模型。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "kind": {"type":"string","enum":["character","scene","blueprint","outfit"]},
                        "id": {"type":"string","description":"素材库里的完整 ID，保留斜杠。"}
                    },
                    "required": ["kind", "id"]
                }
            }
        }),
    ]
});

static CHANNEL_VOICE_TOOL: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "type": "function",
        "function": {
            "name": "send_voice_message",
            "description": "把一段角色台词合成为语音条发送到当前 QQ 对话。只在用户明确要求发语音、朗读或想听你说话时调用；台词只写纯对白文字，不要加舞台动作括号或 Markdown。",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "语音整段内容对应的中文对白（1 到 500 字）。发完语音后直接把这段中文发给对方。写出完整意思，不加标签、括号动作或单独的语气词回执。"
                    },
                    "japanese": {
                        "type": "string",
                        "description": "当前语音使用日语时，在这里填自然口语日译，保留 text 的意思、称呼和情绪，不增删内容。使用其他语言时省略。"
                    },
                    "emotion": {
                        "type": "string",
                        "enum": ["neutral", "gentle", "happy", "shy", "serious", "sad"],
                        "description": "按这句台词的情境选语气。日常问候、闲聊、聊近况用 neutral；gentle 用于安抚或轻声关心；shy 只用于明确要求害羞或当前情境里确实难为情时。缺省 neutral。"
                    },
                    "referenceEmotion": {
                        "type": "string",
                        "enum": ["neutral", "gentle", "happy", "shy", "serious", "sad"],
                        "description": "可选的参考声线情绪。一般省略，随 emotion 使用对应录音。neutral 始终用基础录音。"
                    },
                    "consistency": {
                        "type": "string",
                        "enum": ["locked", "adaptive"],
                        "description": "默认稳定使用同一个声线；只有需要按情绪改用参考时填 adaptive。"
                    },
                    "speed": {
                        "type": "number",
                        "description": "可选语速，1 是正常速度。"
                    }
                },
                "required": ["text"]
            }
        }
    })
});

pub(in crate::chat) fn known_tool(name: &str) -> bool {
    name == "send_voice_message"
        || CHANNEL_DRAWING_TOOLS
            .iter()
            .any(|tool| tool["function"]["name"] == name)
        || TOOLS.iter().any(|tool| tool["function"]["name"] == name)
}

pub(in crate::chat) fn tools(room: bool, web: bool) -> Vec<Value> {
    TOOLS
        .iter()
        .filter(|tool| {
            if tool["function"]["name"] == "search_web" {
                web
            } else {
                room
            }
        })
        .cloned()
        .collect()
}

pub(in crate::chat) fn channel_tools(drawing: bool, voice: bool) -> Vec<Value> {
    let mut selected = Vec::new();
    if drawing {
        selected.extend(CHANNEL_DRAWING_TOOLS.iter().cloned());
        selected.extend(
            TOOLS
                .iter()
                .filter(|tool| {
                    matches!(
                        tool["function"]["name"].as_str(),
                        Some("search_drawing_catalog" | "generate_drawing_batch" | "huiyu_drawing")
                    )
                })
                .cloned()
                .map(|mut tool| {
                    if tool["function"]["name"] == "generate_drawing_batch" {
                        tool["function"]["parameters"]["properties"]["reply"] = json!({
                            "type": "string",
                            "description": "图片提交成功时发给对方的一句角色对白。接着对方刚才的话说，自拍或照片按发照片的语境回应。可以留空直接发图。不要说已经发了，也不要写任务进度。"
                        });
                        tool["function"]["parameters"]["properties"]["photoDescription"] = json!({
                            "type": "string",
                            "description": "可选。这批图实际计划表现的地点、人物或画面，一小句中文，供日后聊起这张图时参考。只根据本次绘图参数和查到的素材写，别照抄技术参数或编造细节。"
                        });
                    }
                    tool
                }),
        );
    }
    if voice {
        selected.push(CHANNEL_VOICE_TOOL.clone());
    }
    selected
}
