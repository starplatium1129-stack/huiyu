'use strict';

var assert: typeof import('assert/strict') = require('assert/strict');
var fs: typeof import('fs') = require('fs');
var os: typeof import('os') = require('os');
var path: typeof import('path') = require('path');
var gatewayStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');
var video: typeof import('../../routes/video') = require('../../routes/video');

function validBody(overrides?: any) {
  return Object.assign({
    prompt:'黄昏的电车站，少女回头看向镜头，风吹起发丝，暖色逆光。',
    modelId:'wan2.2-ti2v-5b',
    aspectRatio:'landscape',
    duration:3,
    camera:'push',
    motion:'subtle',
    seed:12345,
  }, overrides || {});
}

async function json(response: Response) {
  return response.json();
}

async function post(base: string, body: any) {
  return fetch(base + '/api/video/jobs', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
}

async function waitForJob(base: string, id: string|number|boolean) {
  var deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    var result = await json(await fetch(base + '/api/video/jobs/' + encodeURIComponent(id)));
    if (result.job.status === 'succeeded' || result.job.status === 'failed') return result.job;
    await new Promise(function (resolve) { setTimeout(resolve, 40); });
  }
  throw new Error('video job did not finish');
}

async function run() {
  var input = video.validateInput(validBody());
  assert.equal(input.width, 832);
  assert.equal(input.height, 480);
  assert.equal(input.quality, 'standard', 'quality defaults to standard');
  assert.equal(input.frames, 73);
  assert.match(input.prompt, /镜头缓慢推进/);
  assert.doesNotMatch(input.prompt, /细微运动/,
    '控制器运动句让位于文案已写明的动作（回头/看向）');
  assert.equal(video.validateInput(validBody({ quality:'fast' })).width, 608, 'fast quality uses 0.2MP canvas');
  assert.equal(video.validateInput(validBody({ quality:'fast' })).height, 352);
  assert.equal(video.validateInput(validBody({ quality:'fine' })).width, 960, 'fine quality uses 0.5MP canvas');
  assert.equal(video.validateInput(validBody({ quality:'fine', aspectRatio:'portrait' })).height, 960);
  assert.throws(function () {
    video.validateInput(validBody({ quality:'4k' }));
  }, /画质档位/);
  assert.throws(function () {
    video.validateInput(validBody({ workflow:{} }));
  }, /不支持的参数/);
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'ltx-2.3' }));
  }, /适配与实测/);
  assert.throws(function () {
    video.validateInput(validBody({ duration:8 }));
  }, /3 秒或 5 秒/);

  var graph = video.buildWorkflow(input);
  assert.equal(graph['1'].class_type, 'UNETLoader');
  assert.equal(graph['7'].class_type, 'Wan22ImageToVideoLatent');
  assert.equal(graph['7'].inputs.start_image, undefined, 'T2V graph must not invent an image input');
  assert.equal(graph['7'].inputs.length, 73);
  assert.equal(graph['8'].inputs.sampler_name, 'uni_pc');
  assert.equal(graph['10'].class_type, 'CreateVideo');
  assert.equal(graph['11'].class_type, 'SaveVideo');
  // format/codec 必须用官方模板的 'auto'：SaveVideo 的 codec 是动态 combo，
  // 对象值在真实执行会报 missing 'codec'（2026-08-15 真机实测）。
  assert.equal(graph['11'].inputs.format, 'auto');
  assert.equal(graph['11'].inputs.codec, 'auto');

  var h3Input = video.validateInput(validBody({ modelId:'minimax-h3' }));
  assert.equal(h3Input.frames, 73, 'H3 3s must snap to the 17k+5 grid (73)');  assert.equal(h3Input.negative, '', 'H3 is a natural-language model; negative must stay empty');
  assert.match(h3Input.prompt, /^integrated_multimodal_description: \[Shot 1\]/,
    'H3 prompt must open with the official multimodal description field');
  assert.match(h3Input.prompt, /^overall_soundscape:/m, 'H3 prompt must carry the soundscape field');
  assert.match(h3Input.prompt, /^non_diegetic_music:/m, 'H3 prompt must carry the music field');
  assert.match(h3Input.prompt, /The camera pushes in at a slow, steady pace/,
    'H3 camera motion must be a natural English sentence (type + pace)');
  assert.doesNotMatch(h3Input.prompt, /The subject moves only subtly/,
    'H3 motion line yields to prose action words（回头/看向镜头）');
  assert.equal(h3Input.prompt.indexOf('负向'), -1);
  assert.equal(h3Input.width, 832);
  assert.equal(h3Input.height, 480);
  assert.equal(video.validateInput(validBody({ modelId:'minimax-h3', duration:5 })).frames, 124,
    'H3 5s must snap to 124 frames');

  // 文案已自带镜头/动作意图时，控制器句子让位（避免「用户写推进 + 控制器静止」）
  // 这类自相矛盾的指令——H3 是自然语言模型，矛盾指令会产生语义漂移。
  var h3Conflict = video.validateInput(validBody({
    modelId:'minimax-h3',
    prompt:'镜头缓慢推进，少女向着站台走去',
    camera:'still',
    motion:'subtle',
  }));
  assert.doesNotMatch(h3Conflict.prompt, /The camera holds a static shot/,
    'H3 camera line suppressed when prose already states camera movement');
  assert.doesNotMatch(h3Conflict.prompt, /The subject moves only subtly/,
    'H3 motion line suppressed when prose already states an action');
  assert.match(h3Conflict.prompt, /^integrated_multimodal_description: \[Shot 1\]/);

  var h3EnConflict = video.validateInput(validBody({
    modelId:'minimax-h3',
    prompt:'She walks toward the station, camera zooms in slowly',
    camera:'still',
    motion:'subtle',
  }));
  assert.doesNotMatch(h3EnConflict.prompt, /static shot/i, 'English camera mention suppresses the controller line');
  assert.doesNotMatch(h3EnConflict.prompt, /moves only subtly/i, 'English action mention suppresses the controller line');

  // 场景感知 soundscape（官方 4.6：声音必须与画面对应，雨夜不能配「quiet room tone」）。
  var h3Rain = video.validateInput(validBody({
    modelId:'minimax-h3',
    prompt:'暴雨中的神社，少女撑着伞前行',
  }));
  assert.match(h3Rain.prompt, /Steady rain falls across the scene/,
    'soundscape derives scene-consistent rain audio (official 4.6)');
  assert.doesNotMatch(h3Rain.prompt, /Quiet ambient room tone/, 'rain scene must not get the generic room tone');

  // 非 image 模式模型（Wan 5B 只支持文字）拒绝首帧图：buildWanWorkflow 不会消费
  // first_frame，放行会导致「上传了首帧但按文字成片生成」的错误成片。
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'wan2.2-ti2v-5b', image:'aics_video_input_abcdef0123456789.png' }));
  }, /不支持首帧图输入/, 'non-image models reject first-frame input');

  var h3Graph = video.buildWorkflow(h3Input);
  assert.equal(h3Graph['11'].class_type, 'SaveVideo');
  assert.equal(h3Graph['11'].inputs.format, 'auto');
  assert.equal(h3Graph['11'].inputs.codec, 'auto');
  assert.equal(h3Graph['5'].class_type, 'MiniMaxH3ImageToVideo');
  assert.equal(h3Graph['5'].inputs.length, 73);
  assert.equal(h3Graph['5'].inputs.width, 832);
  assert.equal(h3Graph['5'].inputs.height, 480);
  assert.equal(h3Graph['5'].inputs.first_frame, undefined, 'H3 T2V must not invent a first frame');
  assert.equal(h3Graph['2'].inputs.type, 'minimax');
  assert.equal(h3Graph['2'].inputs.clip_name, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors');
  assert.equal(h3Graph['15'].class_type, 'LoraLoaderModelOnly', 'H3 must load the Turbo LoRA');
  assert.equal(h3Graph['15'].inputs.lora_name, 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors');
  assert.equal(h3Graph['15'].inputs.strength_model, 1);
  assert.equal(h3Graph['16'].class_type, 'MiniMaxH3SigmaShift', 'H3 must apply the distilled sigma shifts');
  assert.equal(h3Graph['16'].inputs.shift_video, 12);
  assert.equal(h3Graph['16'].inputs.shift_audio, 3);
  assert.equal(h3Graph['7'].inputs.sampler_name, 'euler', 'Turbo H3 samples with euler');
  assert.equal(h3Graph['8'].inputs.steps, 8, 'Turbo H3 runs 8 distilled steps');
  assert.equal(h3Graph['9'].class_type, 'BasicGuider');
  assert.equal(h3Graph['9'].inputs.model[0], '16');
  assert.equal(h3Graph['8'].inputs.model[0], '16');
  assert.equal(h3Graph['10'].class_type, 'SamplerCustomAdvanced');
  assert.equal(h3Graph['13'].class_type, 'VAEDecodeAudio');
  assert.equal(h3Graph['14'].class_type, 'CreateVideo');
  assert.equal(h3Graph['14'].inputs.audio[0], '13');
  assert.equal(h3Graph['14'].inputs.images[0], '12');
  assert.equal(h3Graph['11'].inputs.video[0], '14');
  assert.equal(JSON.stringify(h3Graph).indexOf('CLIPTextEncode'), -1,
    'H3 graph must not contain a negative-text encoding node');

  // I2VA：首帧图参数与官方首帧指令（h3-prompt-writing base-en.txt 的 I2VA 格式）。
  var h3I2vInput = video.validateInput(validBody({
    modelId:'minimax-h3',
    image:'aics_video_input_abcdef0123456789.png',
  }));
  assert.match(h3I2vInput.prompt,
    /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./,
    'I2VA prompt must open with the official first-frame instruction');
  assert.match(h3I2vInput.prompt,
    /preserve the subject, clothing, hairstyle, and scene from <Picture 1>/);
  assert.match(h3I2vInput.prompt, /\b2D-animated, cinematic\b/, 'H3 prompt must open [Shot 1] with a style anchor (official 4.1)');
  assert.match(h3I2vInput.prompt, /^overall_soundscape:/m);
  assert.doesNotMatch(h3I2vInput.prompt, /fits the mood/, 'H3 music must not use abstract mood words (official 4.7)');
  assert.equal(h3I2vInput.image, 'aics_video_input_abcdef0123456789.png');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', image:'../evil.png' }));
  }, /图片引用格式/);
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', image:'random.png' }));
  }, /图片引用格式/);
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', image:'aics_video_input_123.png' }));
  }, /图片引用格式/);

  var h3I2vGraph = video.buildWorkflow(h3I2vInput);
  assert.equal(h3I2vGraph['17'].class_type, 'LoadImage');
  assert.equal(h3I2vGraph['17'].inputs.image, 'aics_video_input_abcdef0123456789.png');
  assert.deepEqual(h3I2vGraph['5'].inputs.first_frame, ['17', 0],
    'I2VA graph must feed the uploaded first frame into MiniMaxH3ImageToVideo');

  // original 画幅：跟随首帧图比例（只读 PNG IHDR 宽高，不校验 CRC）。
  var fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-video-original-'));
  try {
    var fixtureConfig = { AI_WORKSPACE_ROOT: fixtureRoot, ROOT_DIR: path.resolve(__dirname, '..', '..') };
    var fixtureInputDir = path.join(fixtureRoot, 'ComfyUI', 'input');
    fs.mkdirSync(fixtureInputDir, { recursive:true });
    var tallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    tallPng.writeUInt32BE(832, 16);
    tallPng.writeUInt32BE(1216, 20);
    var fixtureName = 'aics_video_input_' + 'a'.repeat(16) + '.png';
    fs.writeFileSync(path.join(fixtureInputDir, fixtureName), tallPng);

    var originalInput = video.validateInput(validBody({
      modelId:'minimax-h3', image:fixtureName, aspectRatio:'original',
    }), fixtureConfig);
    assert.equal(originalInput.width, 512, 'original follows the 832x1216 ratio at standard area');
    assert.equal(originalInput.height, 768);
    assert.equal(video.validateInput(validBody({
      modelId:'minimax-h3', image:fixtureName, aspectRatio:'original', quality:'fast',
    }), fixtureConfig).width, 384, 'fast original uses a smaller canvas');
    assert.equal(video.validateInput(validBody({
      modelId:'minimax-h3', image:fixtureName, aspectRatio:'original', quality:'fine',
    }), fixtureConfig).width, 608, 'fine original stays within the 16GB envelope');

    assert.throws(function () {
      video.validateInput(validBody({ modelId:'minimax-h3', aspectRatio:'original' }));
    }, /需要先上传首帧图/);
    assert.throws(function () {
      video.validateInput(validBody({ modelId:'minimax-h3', image:fixtureName, aspectRatio:'original' }));
    }, /缺少图片文件上下文/);
    assert.throws(function () {
      video.validateInput(validBody({ modelId:'minimax-h3', image:'aics_video_input_ffffffffffffffff.png', aspectRatio:'original' }), fixtureConfig);
    }, /不存在或已过期/);

    var originalGraph = video.buildWorkflow(originalInput);
    assert.equal(originalGraph['5'].inputs.width, 512);
    assert.equal(originalGraph['5'].inputs.height, 768);
    assert.deepEqual(originalGraph['5'].inputs.first_frame, ['17', 0]);
  } finally {
    fs.rmSync(fixtureRoot, { recursive:true, force:true });
  }
  assert.deepEqual(
    video.validateVideoReference({ filename:'aics_video_00001_.mp4', subfolder:'', type:'output' }),
    { filename:'aics_video_00001_.mp4', subfolder:'', type:'output' }
  );
  assert.throws(function () {
    video.validateVideoReference({ filename:'../aics_video.mp4', subfolder:'', type:'output' });
  }, /允许范围/);
  assert.throws(function () {
    video.validateVideoReference({ filename:'ComfyUI.mp4', subfolder:'', type:'output' });
  }, /前缀/);

  // ── P7 对白（官方 4.4：说话人 ID + <d>[语言标签] 原文</d> 块）──────────
  var h3Dialogue = video.validateInput(validBody({
    modelId:'minimax-h3',
    dialogue:'我在这站下车。',
  }));
  assert.match(h3Dialogue.prompt,
    /The subject in the frame \(S1\) says: <d>\[Chinese\] 我在这站下车。<\/d>/,
    'H3 dialogue must use the official speaker-ID + <d> verbatim block');
  var h3EnDialogue = video.validateInput(validBody({
    modelId:'minimax-h3',
    dialogue:'Wait for me!',
  }));
  assert.match(h3EnDialogue.prompt, /<d>\[English\] Wait for me!<\/d>/,
    'non-CJK dialogue gets the English language tag');
  var h3JpDialogue = video.validateInput(validBody({
    modelId:'minimax-h3',
    dialogue:'ありがとう。本当に。',
  }));
  assert.match(h3JpDialogue.prompt, /<d>\[Japanese\] ありがとう。本当に。<\/d>/,
    'kana dialogue gets the Japanese language tag (2026-08-17 日漫角色说日语)');

  // 显式语言标签优先于字符自动判定：中文台词想强制日语/英文，或日文想强制中文都行。
  var h3ExplicitZh = video.validateInput(validBody({
    modelId:'minimax-h3',
    dialogue:'ありがとう。本当に。',
    dialogueLang:'zh',
  }));
  assert.match(h3ExplicitZh.prompt, /<d>\[Chinese\] ありがとう。本当に。<\/d>/,
    'dialogueLang:zh forces the Chinese tag even for kana text');
  var h3ExplicitJa = video.validateInput(validBody({
    modelId:'minimax-h3',
    dialogue:'我在这站下车。',
    dialogueLang:'ja',
  }));
  assert.match(h3ExplicitJa.prompt, /<d>\[Japanese\] 我在这站下车。<\/d>/,
    'dialogueLang:ja forces the Japanese tag even for Chinese text');
  var h3ExplicitEn = video.validateInput(validBody({
    modelId:'minimax-h3',
    dialogue:'我在这站下车。',
    dialogueLang:'en',
  }));
  assert.match(h3ExplicitEn.prompt, /<d>\[English\] 我在这站下车。<\/d>/,
    'dialogueLang:en forces the English tag');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', dialogue:'你好', dialogueLang:'fr' }));
  }, /对白语言仅支持 auto\/zh\/ja\/en/, 'unknown dialogueLang is rejected');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'wan2.2-ti2v-5b', dialogue:'你好' }));
  }, /对白仅支持 MiniMax H3/, 'non-H3 models reject dialogue input');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', dialogue:'x'.repeat(301) }));
  }, /对白需为 1—300/, 'dialogue length is capped');

  // ── P5 景别（官方 4.1 构图句）──────────────────────────────────────────
  var h3Wide = video.validateInput(validBody({ modelId:'minimax-h3', shotSize:'wide' }));
  assert.match(h3Wide.prompt, /framed as a wide establishing shot/,
    'shotSize renders an English composition sentence');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', shotSize:'extreme' }));
  }, /不支持的景别/);
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'wan2.2-ti2v-5b', shotSize:'wide' }));
  }, /景别仅支持 MiniMax H3/);

  // ── 极速 4 步（2026-08-16 真机实测：fast 5s 130s → 80s，质量抽查可接受）──
  assert.equal(video.validateInput(validBody({ modelId:'minimax-h3' })).steps, 8, 'H3 defaults to 8 steps');
  var h3Fast4 = video.validateInput(validBody({ modelId:'minimax-h3', steps:4 }));
  assert.equal(h3Fast4.steps, 4);
  assert.equal(video.buildWorkflow(h3Fast4)['8'].inputs.steps, 4, '4-step graph drives BasicScheduler steps');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', steps:6 }));
  }, /步数只支持/, 'steps outside 4/8 rejected');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'wan2.2-ti2v-5b', steps:4 }));
  }, /极速步数仅支持 MiniMax H3/, 'non-H3 models reject step override');

  // H3 长镜档：10s/15s 在训练区间（124–362 帧）内，16GB 真机已验证（std10=430s, std15=671s）。
  assert.equal(video.validateInput(validBody({ modelId:'minimax-h3', duration:10 })).frames, 243, 'H3 10s snaps to the 17k+5 grid (243)');
  assert.equal(video.validateInput(validBody({ modelId:'minimax-h3', duration:15 })).frames, 362, 'H3 15s snaps to 362 frames');
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'wan2.2-ti2v-5b', duration:10 }));
  }, /只支持 3 秒或 5 秒/, 'Wan keeps 3/5 only');

  // ── P6 FL2VA / L2VA（官方 base-en.txt 2.1 参考对齐指令 + 尾帧节点）──────
  var fl2vaInput = video.validateInput(validBody({
    modelId:'minimax-h3',
    image:'aics_video_input_abcdef0123456789.png',
    lastFrame:'aics_video_input_0123456789abcdef.png',
    duration:5,
  }));
  assert.match(fl2vaInput.prompt,
    /^How the reference pictures align with the target video — Picture 1 \(from Shot 1\) aligns with the 0\.00-second mark of the target video; Picture 2 \(from Shot 1\) aligns with the 5\.00-second mark of the target video\./,
    'FL2VA must open with the official first-and-last-frame alignment instruction');
  assert.match(fl2vaInput.prompt, /settles into the final pose, spacing, and composition established by Picture 2/);
  var fl2vaGraph = video.buildWorkflow(fl2vaInput);
  assert.equal(fl2vaGraph['18'].class_type, 'LoadImage');
  assert.equal(fl2vaGraph['18'].inputs.image, 'aics_video_input_0123456789abcdef.png');
  assert.deepEqual(fl2vaGraph['5'].inputs.first_frame, ['17', 0]);
  assert.deepEqual(fl2vaGraph['5'].inputs.last_frame, ['18', 0],
    'FL2VA graph must feed the tail frame into MiniMaxH3ImageToVideo.last_frame');
  var l2vaInput = video.validateInput(validBody({
    modelId:'minimax-h3',
    lastFrame:'aics_video_input_0123456789abcdef.png',
    duration:3,
  }));
  assert.match(l2vaInput.prompt,
    /^How the reference pictures align with the target video — <Picture 1> \(from \[Shot 1\]\) aligns with the 3\.00-second mark of the target video\./,
    'L2VA must open with the official last-frame convergence instruction');
  var l2vaGraph = video.buildWorkflow(l2vaInput);
  assert.equal(l2vaGraph['5'].inputs.first_frame, undefined, 'L2VA has no first frame');
  assert.deepEqual(l2vaGraph['5'].inputs.last_frame, ['18', 0]);
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'minimax-h3', lastFrame:'../evil.png' }));
  }, /尾帧图片引用格式/);
  assert.throws(function () {
    video.validateInput(validBody({ modelId:'wan2.2-ti2v-5b', lastFrame:'aics_video_input_0123456789abcdef.png' }));
  }, /不支持尾帧图输入/, 'non-FL models reject last-frame input');

  // ── 成人内容传输层门控（assertAdultAllowed：本机放行 / 缺授权拒绝 / 远程拒绝）──
  var adultPrompt = validBody({ prompt:'nude explicit scene, naked character', adultEnabled:true });
  // 本机直连 + adultEnabled:true → 放行（不抛）。
  assert.doesNotThrow(function () {
    video.validateInput(adultPrompt, null, { isLocal:true });
  }, 'local + adultEnabled:true passes the transport gate');
  // 本机直连但未声明授权 → 拒绝。
  assert.throws(function () {
    video.validateInput(validBody({ prompt:'nude explicit scene' }), null, { isLocal:true });
  }, /ADULT_NOT_ENABLED|成人内容未获本机授权/, 'missing adultEnabled is rejected fail-closed');
  // 远程/隧道访问 → 无条件拒绝（在 adultEnabled 检查之前短路）。
  assert.throws(function () {
    video.validateInput(adultPrompt, null, { isLocal:false });
  }, /ADULT_REMOTE_NOT_ALLOWED|仅限本机直连/, 'remote access rejects adult params');
  // 普通文案（无 R18 词）不受门控影响，三种环境均放行。
  assert.doesNotThrow(function () {
    video.validateInput(validBody(), null, { isLocal:false });
  }, 'non-adult prompts are unaffected by the gate');
  // 批次级透传：adultEnabled 随批次进入单镜校验。
  var batchAdult = video.validateBatchInput({
    modelId:'minimax-h3',
    aspectRatio:'landscape',
    adultEnabled:true,
    shots:[{ prompt:'nude explicit scene, naked character' }],
  });
  assert.equal(batchAdult.adultEnabled, true, 'batch carries the transport flag through');
  assert.throws(function () {
    video.validateBatchInput({
      modelId:'minimax-h3',
      aspectRatio:'landscape',
      shots:[{ prompt:'nude explicit scene, naked character' }],
    });
  }, /成人内容未获本机授权/, 'batch without the flag is rejected per shot');

  // ── T8 双时钟路径（2026-08-16 默认提速路径；真机 standard 5s 228s → 90s）──
  video.setT8Available(true);
  try {
    var t8Input = video.validateInput(validBody({ modelId:'minimax-h3', steps:4 }));
    var t8Graph = video.buildWorkflow(t8Input);
    assert.equal(t8Graph['5'].class_type, 'MiniMaxH3AudioConditioningT8', 'T8 path conditions via the T8 node');
    assert.equal(t8Graph['5'].inputs.task_type, 'T2VA');
    assert.equal(t8Graph['5'].inputs.audio_mode, 'native');
    assert.equal(t8Graph['15'].class_type, 'LoraLoaderBypassModelOnly', 'T8 path loads the 4-step turbo LoRA');
    assert.equal(t8Graph['15'].inputs.lora_name, 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors');
    assert.equal(t8Graph['16'].class_type, 'MiniMaxH3DualClockSamplerT8', 'T8 path samples via dual-clock');
    assert.equal(t8Graph['16'].inputs.steps, 4);
    assert.equal(t8Graph['16'].inputs.shift_video, 12);
    assert.equal(t8Graph['16'].inputs.shift_audio, 3);
    assert.equal(t8Graph['12'].class_type, 'MiniMaxH3AVDecodeT8');
    assert.equal(t8Graph['14'].class_type, 'CreateVideo');
    assert.equal(t8Graph['14'].inputs.audio[0], '12');
    assert.equal(t8Graph['11'].class_type, 'SaveVideo');
    assert.equal(t8Graph['11'].inputs.format, 'auto');
    assert.equal(JSON.stringify(t8Graph).indexOf('MiniMaxH3ImageToVideo'), -1, 'T8 path must not use the stock node');
    assert.equal(JSON.stringify(t8Graph).indexOf('MiniMaxH3SigmaShift'), -1, 'T8 path must not use the stock sigma shift');
    var t8I2v = video.buildWorkflow(video.validateInput(validBody({
      modelId:'minimax-h3', image:'aics_video_input_abcdef0123456789.png',
    })));
    assert.equal(t8I2v['5'].inputs.task_type, 'I2VA');
    assert.deepEqual(t8I2v['5'].inputs.first_frame, ['17', 0]);
    var t8Fl2v = video.buildWorkflow(video.validateInput(validBody({
      modelId:'minimax-h3', image:'aics_video_input_abcdef0123456789.png',
      lastFrame:'aics_video_input_0123456789abcdef.png',
    })));
    assert.equal(t8Fl2v['5'].inputs.task_type, 'FL2VA');
    assert.deepEqual(t8Fl2v['5'].inputs.last_frame, ['18', 0]);
    var t8L2v = video.buildWorkflow(video.validateInput(validBody({
      modelId:'minimax-h3', lastFrame:'aics_video_input_0123456789abcdef.png',
    })));
    assert.equal(t8L2v['5'].inputs.task_type, 'L2VA');
    assert.equal(t8L2v['5'].inputs.first_frame, undefined);

    // Ref2VA 参考图（角色卡）：仅参考 → ref2va；参考+首帧 → hybrid；
    // ref_image_N autogrow 槽 + <Picture N> 身份声明注入。
    var t8Ref = video.buildWorkflow(video.validateInput(validBody({
      modelId:'minimax-h3',
      references:['aics_video_ref_abcdef0123456789.png', 'aics_video_ref_0123456789abcdef.png'],
    })));
    assert.equal(t8Ref['5'].inputs.task_type, 'Ref2VA');
    assert.deepEqual(t8Ref['5'].inputs['ref_images.ref_image_0'], ['21', 0]);
    assert.deepEqual(t8Ref['5'].inputs['ref_images.ref_image_1'], ['22', 0]);
    assert.equal(t8Ref['21'].class_type, 'LoadImage');
    assert.equal(t8Ref['21'].inputs.image, 'aics_video_ref_abcdef0123456789.png');
    assert.match(t8Ref['5'].inputs.prompt, /<Picture 1>/);
    assert.match(t8Ref['5'].inputs.prompt, /<Picture 2>/);
    var t8Hybrid = video.buildWorkflow(video.validateInput(validBody({
      modelId:'minimax-h3',
      image:'aics_video_input_abcdef0123456789.png',
      references:['aics_video_ref_0123456789abcdef.png'],
    })));
    assert.equal(t8Hybrid['5'].inputs.task_type, 'Hybrid');
    assert.deepEqual(t8Hybrid['5'].inputs['ref_images.ref_image_0'], ['21', 0]);
    assert.throws(function () {
      video.validateInput(validBody({
        modelId:'minimax-h3', references:['bad name.png'],
      }));
    }, /格式不受支持/);
    assert.throws(function () {
      video.validateInput(validBody({
        modelId:'wan2.2-ti2v-5b', references:['aics_video_ref_abcdef0123456789.png'],
      }));
    }, /仅支持 MiniMax H3/);
  } finally {
    video.setT8Available(false);
  }

  // ── 场景蓝图一键剧本（2026-08-23）：确定性四镜派生 + 成人 fail-closed ─────
  var storyboardEngine: typeof import('../../routes/video/storyboard') = require('../../routes/video/storyboard');
  var fixtureBlueprint = {
    id:'fixture_blueprint', title:'花海逆光', category:'现代日常', characterId:'raiden_shogun',
    description:'【雷电将军 · 花海逆光】金色夕阳洒满花海。她蓦然回望——「永恒并非只有静止不变。」晚风拂过，她轻声补充「有你相伴的此刻，同样值得铭记。」',
    location:'郊野花田', action:'站在花海间回望', timeOfDay:'黄昏',
    lighting:'金色逆光', mood:'静谧温柔',
    promptProse:'In a vast flower field at golden hour, she stands among blooming cosmos flowers.',
  };
  var fixtureBoard = storyboardEngine.buildStoryboard(fixtureBlueprint, { intent:'她把一朵花别到耳边' });
  assert.deepEqual(fixtureBoard.beats, ['establishing', 'interaction', 'emotion', 'closing']);
  assert.equal(fixtureBoard.shots.length, 4);
  assert.equal(fixtureBoard.shots[0].shotSize, 'wide');
  assert.equal(fixtureBoard.shots[3].camera, 'pull', 'closing shot pulls back out');
  assert.equal(fixtureBoard.shots[1].dialogue, '永恒并非只有静止不变。', 'first quoted line lands on the interaction beat');
  assert.equal(fixtureBoard.shots[2].dialogue, '有你相伴的此刻，同样值得铭记。', 'second quoted line lands on the emotion beat');
  assert.equal(fixtureBoard.shots[0].dialogue, null);
  assert.match(fixtureBoard.shots[2].prompt, /她把一朵花别到耳边/, 'intent merges into the emotion beat');
  // 首帧提示词：蓝图散文基底 + 景别构图句，四镜构图变奏不雷同。
  assert.match(fixtureBoard.shots[0].firstFramePrompt, /vast flower field/);
  assert.match(fixtureBoard.shots[0].firstFramePrompt, /wide establishing shot/);
  assert.match(fixtureBoard.shots[1].firstFramePrompt, /medium shot centered on her action/);
  assert.match(fixtureBoard.shots[2].firstFramePrompt, /close-up portrait of her face/);
  var noProseBoard = storyboardEngine.buildStoryboard(
    Object.assign({}, fixtureBlueprint, { promptProse:'' }), {});
  assert.match(noProseBoard.shots[0].firstFramePrompt, /花海逆光/, 'missing prose falls back to the Chinese description');
  assert.equal(storyboardEngine.characterNameOf(fixtureBlueprint), '雷电将军', 'character name parsed from the 【】 title prefix');
  assert.equal(storyboardEngine.extractDialogues('没有任何台词的描述').length, 0);
  // 剧本 → 现有三段式组装闭环：镜头描述直接喂 H3 校验器必须产出合法三段式。
  var storyboardShotInput = video.validateInput({
    prompt:fixtureBoard.shots[1].prompt, modelId:'minimax-h3', aspectRatio:'landscape',
    duration:fixtureBoard.shots[1].duration, dialogue:fixtureBoard.shots[1].dialogue,
    camera:fixtureBoard.shots[1].camera, motion:fixtureBoard.shots[1].motion,
    shotSize:fixtureBoard.shots[1].shotSize, seed:77,
  });
  assert.match(storyboardShotInput.prompt, /integrated_multimodal_description: /);
  assert.match(storyboardShotInput.prompt, /non_diegetic_music: /);
    assert.match(storyboardShotInput.prompt, /<d>\[Chinese\] 永恒并非只有静止不变。<\/d>/, 'dialogue preserved verbatim in the <d> block');

  // 从真实数据文件取普通/成人蓝图各一，HTTP 用例对数据演进保持鲁棒。
  var realBlueprints = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'data', 'scene-blueprints.json'), 'utf8')).blueprints;
  var normalBlueprint = realBlueprints.find(function (item: any) { return item.category === '现代日常' && /「/.test(item.description || ''); });
  var adultBlueprint = realBlueprints.find(function (item: { category: string; }) { return item.category === '成人' || item.category === '私密写真'; });
  assert.ok(normalBlueprint && adultBlueprint, 'fixture data must contain normal and adult blueprints');

  var missingStack = await gatewayStack.start();
  try {
    var boardResponse = await fetch(missingStack.baseUrl + '/api/video/storyboard', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ blueprintId:normalBlueprint.id }),
    });
    assert.equal(boardResponse.status, 200);
    var boardBody = await json(boardResponse);
    assert.equal(boardBody.storyboard.blueprintId, normalBlueprint.id);
    assert.equal(boardBody.storyboard.shots.length, 4, 'storyboard endpoint returns the four-beat plan');
    var quoted = (normalBlueprint.description.match(/「[^「」]+」/g) || []).map(function (raw: string|any[]) { return raw.slice(1, -1); });
    if (quoted.length) {
      assert.equal(boardBody.storyboard.shots[1].dialogue, quoted[0], 'server extraction matches the fixture expectation');
    }
    var unknownBoard = await fetch(missingStack.baseUrl + '/api/video/storyboard', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ blueprintId:'no_such_blueprint' }),
    });
    assert.equal(unknownBoard.status, 404);
    assert.equal((await json(unknownBoard)).code, 'UNKNOWN_BLUEPRINT');
    var adultBoard = await fetch(missingStack.baseUrl + '/api/video/storyboard', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ blueprintId:adultBlueprint.id }),
    });
    assert.equal(adultBoard.status, 400);
    assert.equal((await json(adultBoard)).code, 'ADULT_BLUEPRINT_UNSUPPORTED',
      'adult blueprints must stay fail-closed until the video-side adult gate lands');
    var status = await json(await fetch(missingStack.baseUrl + '/api/video/status'));
    assert.equal(status.online, true);
    assert.equal(status.qualities.length, 3, 'status must expose the three quality tiers');
    assert.equal(status.qualities[0].id, 'fast');
    assert.equal(status.qualities[1].id, 'standard');
    assert.equal(status.qualities[2].id, 'fine');
    assert.equal(status.qualities[1].sizes.landscape, '832 × 480');
    assert.equal(status.qualities[2].sizes.landscape, '960 × 544');
    var wan = status.models.find(function (model: { id: string; }) { return model.id === 'wan2.2-ti2v-5b'; });
    assert.equal(wan.available, false);
    assert.deepEqual(wan.missing, [
      'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
      'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      'vae/wan2.2_vae.safetensors',
    ]);
    var h3 = status.models.find(function (model: { id: string; }) { return model.id === 'minimax-h3'; });
    assert.equal(h3.executable, true, 'H3 adapter must be executable once the workflow is wired');
    assert.equal(h3.available, false);
    assert.deepEqual(h3.missing, [
      'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      'vae/minimax_h3_video_vae_fp16.safetensors',
      'vae/minimax_h3_audio_vae_fp32.safetensors',
      'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
      'loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    ]);
    var missingResponse = await post(missingStack.baseUrl, validBody());
    assert.equal(missingResponse.status, 503);
    assert.equal((await json(missingResponse)).code, 'VIDEO_MODEL_UNAVAILABLE');
    var h3MissingResponse = await post(missingStack.baseUrl, validBody({ modelId:'minimax-h3' }));
    assert.equal(h3MissingResponse.status, 503);
    assert.equal((await json(h3MissingResponse)).code, 'VIDEO_MODEL_UNAVAILABLE');
    var unknownResponse = await post(missingStack.baseUrl, validBody({ workflow:{} }));
    assert.equal(unknownResponse.status, 400);
    assert.equal((await json(unknownResponse)).code, 'UNKNOWN_PARAMETER');
  } finally {
    await missingStack.close();
  }

  var readyStack = await gatewayStack.start({
    prepare:function (context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
      var root = path.join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models');
      for (var model of video.constants.MODEL_CATALOG) {
        for (var requirement of model.requirements) {
          var dir = path.join(root, requirement[0]);
          fs.mkdirSync(dir, { recursive:true });
          fs.writeFileSync(path.join(dir, requirement[1]), requirement[1]);
        }
      }
    },
  });
  try {
    var readyStatus = await json(await fetch(readyStack.baseUrl + '/api/video/status'));
    assert.equal(readyStatus.models[0].available, true);
    var createResponse = await post(readyStack.baseUrl, validBody());
    assert.equal(createResponse.status, 202);
    var created = (await json(createResponse)).job;
    assert.equal(created.modelId, 'wan2.2-ti2v-5b');

    var comfyState = await json(await fetch(readyStack.upstreams.comfy.url + '/__mock/state'));
    var promptCall = comfyState.calls.find(function (call: { path: string; }) { return call.path === '/prompt'; });
    assert.ok(promptCall);
    assert.equal(promptCall.body.prompt['11'].class_type, 'SaveVideo');
    assert.equal(promptCall.body.prompt['7'].inputs.width, 832);
    assert.equal(promptCall.body.prompt['7'].inputs.height, 480);

    var finished = await waitForJob(readyStack.baseUrl, created.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.resultAvailable, true);
    var result = await fetch(readyStack.baseUrl + finished.resultUrl, {
      headers:{ Range:'bytes=0-7' },
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get('content-type'), 'video/mp4');
    assert.equal(result.headers.get('content-range'), 'bytes 0-7/28');
    assert.equal((await result.arrayBuffer()).byteLength, 8);

    var h3CreateResponse = await post(readyStack.baseUrl, validBody({ modelId:'minimax-h3' }));
    assert.equal(h3CreateResponse.status, 202);
    var h3Created = (await json(h3CreateResponse)).job;
    assert.equal(h3Created.modelId, 'minimax-h3');
    assert.equal(h3Created.width, 832);
    assert.equal(h3Created.height, 480);

    var h3State = await json(await fetch(readyStack.upstreams.comfy.url + '/__mock/state'));
    var h3PromptCall = h3State.calls.find(function (call: { path: string; body: { prompt: { [x: string]: { class_type: string; }; }; }; }) {
      return call.path === '/prompt'
        && call.body && call.body.prompt && call.body.prompt['5']
        && call.body.prompt['5'].class_type === 'MiniMaxH3ImageToVideo';
    });
    assert.ok(h3PromptCall, 'H3 submit must carry the native MiniMaxH3ImageToVideo graph');
    assert.equal(h3PromptCall.body.prompt['5'].inputs.length, 73);
    assert.equal(h3PromptCall.body.prompt['11'].class_type, 'SaveVideo');
    assert.equal(h3PromptCall.body.prompt['13'].class_type, 'VAEDecodeAudio');
    assert.equal(h3PromptCall.body.prompt['15'].class_type, 'LoraLoaderModelOnly');
    assert.equal(h3PromptCall.body.prompt['16'].class_type, 'MiniMaxH3SigmaShift');
    assert.equal(h3PromptCall.body.prompt['8'].inputs.steps, 8);

    var h3Finished = await waitForJob(readyStack.baseUrl, h3Created.id);
    assert.equal(h3Finished.status, 'succeeded');
    assert.equal(h3Finished.resultAvailable, true);

    // I2VA 全流程：上传首帧 → 提交带 image 的任务 → LoadImage + first_frame → 成功。
    var tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    var badUpload = await fetch(readyStack.baseUrl + '/api/video/images', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ data:'aGVsbG8gd29ybGQ=' }),
    });
    assert.equal(badUpload.status, 400);
    assert.equal((await json(badUpload)).code, 'INVALID_IMAGE');
    var emptyUpload = await fetch(readyStack.baseUrl + '/api/video/images', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({}),
    });
    assert.equal(emptyUpload.status, 400);
    assert.equal((await json(emptyUpload)).code, 'INVALID_IMAGE');
    var uploadRes = await fetch(readyStack.baseUrl + '/api/video/images', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ data:tinyPngBase64 }),
    });
    assert.equal(uploadRes.status, 200);
    var uploadBody = await json(uploadRes);
    assert.match(uploadBody.name, /^aics_video_input_[a-f0-9]{16}\.png$/, 'upload must return a controlled input filename');
    assert.equal(uploadBody.bytes, 70);

    var h3I2vCreate = await post(readyStack.baseUrl, validBody({
      modelId:'minimax-h3',
      image:uploadBody.name,
      prompt:'少女轻轻转头看向镜头',
    }));
    assert.equal(h3I2vCreate.status, 202, 'I2VA job with an uploaded image must submit');
    var h3I2vJob = (await json(h3I2vCreate)).job;
    var i2vState = await json(await fetch(readyStack.upstreams.comfy.url + '/__mock/state'));
    var i2vCall = i2vState.calls.find(function (call: { path: string; body: { prompt: { [x: string]: { class_type: string; }; }; }; }) {
      return call.path === '/prompt' && call.body && call.body.prompt && call.body.prompt['17']
        && call.body.prompt['17'].class_type === 'LoadImage';
    });
    assert.ok(i2vCall, 'I2VA submit must carry a LoadImage node');
    assert.equal(i2vCall.body.prompt['17'].inputs.image, uploadBody.name);
    assert.deepEqual(i2vCall.body.prompt['5'].inputs.first_frame, ['17', 0]);
    var i2vFinished = await waitForJob(readyStack.baseUrl, h3I2vJob.id);
    assert.equal(i2vFinished.status, 'succeeded');
    assert.equal(i2vFinished.resultAvailable, true);

    // original 画幅全流程：上传 832x1216 首帧 → 提交 original → 画布按比例计算。
    var tallUploadPng = Buffer.from(tinyPngBase64, 'base64');
    tallUploadPng.writeUInt32BE(832, 16);
    tallUploadPng.writeUInt32BE(1216, 20);
    var tallUpload = await fetch(readyStack.baseUrl + '/api/video/images', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ data:tallUploadPng.toString('base64') }),
    });
    assert.equal(tallUpload.status, 200);
    var tallName = (await json(tallUpload)).name;
    var originalCreate = await post(readyStack.baseUrl, validBody({
      modelId:'minimax-h3',
      image:tallName,
      aspectRatio:'original',
      prompt:'少女轻轻转头看向镜头',
    }));
    assert.equal(originalCreate.status, 202, 'original-aspect I2VA job must submit');
    var originalJob = (await json(originalCreate)).job;
    assert.equal(originalJob.width, 512, 'job reports the ratio-fitted canvas');
    assert.equal(originalJob.height, 768);
    var originalState = await json(await fetch(readyStack.upstreams.comfy.url + '/__mock/state'));
    var originalCall = originalState.calls.find(function (call: { path: string; body: { prompt: { [x: string]: { inputs: { width: number; }; }; }; }; }) {
      return call.path === '/prompt' && call.body && call.body.prompt && call.body.prompt['5']
        && call.body.prompt['5'].inputs.width === 512;
    });
    assert.ok(originalCall, 'original submit must carry the ratio-fitted width');
    assert.equal(originalCall.body.prompt['5'].inputs.height, 768);
    var originalFinished = await waitForJob(readyStack.baseUrl, originalJob.id);
    assert.equal(originalFinished.status, 'succeeded');

    assert.equal((await fetch(readyStack.baseUrl + '/prompt')).status, 404);
    assert.equal((await fetch(readyStack.baseUrl + '/history/demo')).status, 404);
  } finally {
    await readyStack.close();
  }

  // ── T8 双时钟路径网关验证（t8Available 注入 → 提交 T8 图 → mock 全流程）──
  var t8Stack = await gatewayStack.start({
    prepare:function (context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
      var root = path.join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models');
      for (var model of video.constants.MODEL_CATALOG) {
        for (var requirement of model.requirements) {
          var dir = path.join(root, requirement[0]);
          fs.mkdirSync(dir, { recursive:true });
          fs.writeFileSync(path.join(dir, requirement[1]), requirement[1]);
        }
      }
    },
    services:{ t8Available:true },
  });
  try {
    var t8Create = await post(t8Stack.baseUrl, validBody({ modelId:'minimax-h3', steps:4 }));
    assert.equal(t8Create.status, 202);
    var t8Job = (await json(t8Create)).job;
    var t8State = await json(await fetch(t8Stack.upstreams.comfy.url + '/__mock/state'));
    var t8Call = t8State.calls.find(function (call: { path: string; body: { prompt: { [x: string]: { class_type: string; }; }; }; }) {
      return call.path === '/prompt' && call.body && call.body.prompt
        && call.body.prompt['5'] && call.body.prompt['5'].class_type === 'MiniMaxH3AudioConditioningT8';
    });
    assert.ok(t8Call, 'T8-enabled gateway must submit the dual-clock conditioning node');
    assert.equal(t8Call.body.prompt['16'].class_type, 'MiniMaxH3DualClockSamplerT8');
    assert.equal(t8Call.body.prompt['16'].inputs.steps, 4);
    assert.equal(t8Call.body.prompt['15'].class_type, 'LoraLoaderBypassModelOnly');
    var t8Finished = await waitForJob(t8Stack.baseUrl, t8Job.id);
    assert.equal(t8Finished.status, 'succeeded');
    assert.equal(t8Finished.resultAvailable, true);
  } finally {
    await t8Stack.close();
  }

  // ── P5/P6/P8 网关：分镜批量（逐镜排队 + 尾帧衔接 + 拼接）───────────────
  var fakeFfmpeg = async function (args: string|any[]) {
    var out: any = args[args.length - 1];
    if (String(out).endsWith('.png')) {
      fs.writeFileSync(out, Buffer.from(tinyPngBase64, 'base64'));
    } else if (String(out).endsWith('.mp4')) {
      fs.writeFileSync(out, Buffer.from('fake-batch-mp4'));
    } else {
      throw new Error('unexpected ffmpeg output: ' + out);
    }
  };
  var batchStack = await gatewayStack.start({
    prepare:function (context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
      var root = path.join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models');
      for (var model of video.constants.MODEL_CATALOG) {
        for (var requirement of model.requirements) {
          var dir = path.join(root, requirement[0]);
          fs.mkdirSync(dir, { recursive:true });
          fs.writeFileSync(path.join(dir, requirement[1]), requirement[1]);
        }
      }
    },
    services:{ runFfmpeg:fakeFfmpeg, batchPollIntervalMs:50 },
  });
  try {
    // 参数契约：批量拒绝逐镜歧义画幅/空镜头/未知字段/超量镜头。
    var badBatch = await fetch(batchStack.baseUrl + '/api/video/batches', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ modelId:'minimax-h3', aspectRatio:'original', shots:[{ prompt:'一镜' }] }),
    });
    assert.equal(badBatch.status, 400);
    assert.equal((await json(badBatch)).code, 'INVALID_PARAMETER', 'batch rejects per-shot-ambiguous aspect');
    var emptyShots = await fetch(batchStack.baseUrl + '/api/video/batches', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ modelId:'minimax-h3', aspectRatio:'landscape', shots:[] }),
    });
    assert.equal(emptyShots.status, 400);
    var badShotKey = await fetch(batchStack.baseUrl + '/api/video/batches', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ modelId:'minimax-h3', aspectRatio:'landscape', shots:[{ prompt:'一镜', workflow:{} }] }),
    });
    assert.equal(badShotKey.status, 400);
    assert.equal((await json(badShotKey)).code, 'UNKNOWN_PARAMETER');
    var tooMany = await fetch(batchStack.baseUrl + '/api/video/batches', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        modelId:'minimax-h3', aspectRatio:'landscape',
        shots:Array.from({ length:31 }, function () { return { prompt:'一镜' }; }),
      }),
    });
    assert.equal(tooMany.status, 400);
    assert.match((await json(tooMany)).error, /分镜数量/);

    // 三镜批量：镜 1 上传首帧（I2VA），镜 2 由服务端续接首帧，镜 3 自带关键帧 + 自动衔接尾帧（FL2VA）。
    var shot1Upload = await fetch(batchStack.baseUrl + '/api/video/images', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ data:tinyPngBase64 }),
    });
    var shot1Name = (await json(shot1Upload)).name;
    var shot3Upload = await fetch(batchStack.baseUrl + '/api/video/images', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ data:tinyPngBase64 }),
    });
    var shot3Name = (await json(shot3Upload)).name;
    var batchCreate = await fetch(batchStack.baseUrl + '/api/video/batches', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        modelId:'minimax-h3',
        aspectRatio:'landscape',
        quality:'standard',
        steps:4,
        linkLastFrame:true,
        shots:[
          { prompt:'雨夜少女撑着伞走向车站', image:shot1Name, shotSize:'wide' },
          { prompt:'少女回眸看向镜头', dialogue:'我在这站下车。', camera:'push' },
          { prompt:'少女推门走进车站大厅', image:shot3Name, duration:5 },
        ],
      }),
    });
    assert.equal(batchCreate.status, 202, 'batch submit must return 202');
    var createdBatch = (await json(batchCreate)).batch;
    assert.equal(createdBatch.status, 'running');
    assert.equal(createdBatch.shots.length, 3);
    assert.equal(createdBatch.steps, 4, 'batch exposes the 4-step fast tier');

    var deadline = Date.now() + 20000;
    var finalBatch;
    while (Date.now() < deadline) {
      finalBatch = (await json(await fetch(batchStack.baseUrl + '/api/video/batches/' + createdBatch.id))).batch;
      if (finalBatch.status === 'done' || finalBatch.status === 'paused' || finalBatch.status === 'cancelled') break;
      await new Promise(function (resolve) { setTimeout(resolve, 60); });
    }
    assert.equal(finalBatch.status, 'done', 'all shots must succeed');
    assert.deepEqual(finalBatch.progress, { total:3, succeeded:3, failed:0 });
    finalBatch.shots.forEach(function (shot: any) {
      assert.equal(shot.status, 'succeeded');
      assert.equal(shot.attempts, 1);
      assert.equal(shot.resultAvailable, true);
    });
    assert.equal(finalBatch.shots[0].dialogue, null);
    assert.equal(finalBatch.shots[1].dialogue, '我在这站下车。');
    assert.equal(finalBatch.shots[1].shotSize, null);
    assert.equal(finalBatch.shots[0].shotSize, 'wide');

    // 尾帧衔接断言：镜 2 收到服务端抽取的受控尾帧（I2VA 续接），
    // 镜 3 收到首帧 + 尾帧（FL2VA 官方指令）。
    var batchComfyState = await json(await fetch(batchStack.upstreams.comfy.url + '/__mock/state'));
    var shotPrompts = batchComfyState.calls.filter(function (call: { path: string; body: { prompt: { [x: string]: { class_type: string; }; }; }; }) {
      return call.path === '/prompt' && call.body && call.body.prompt
        && call.body.prompt['5'] && call.body.prompt['5'].class_type === 'MiniMaxH3ImageToVideo';
    });
    assert.ok(shotPrompts.length >= 3, 'batch must submit one ComfyUI prompt per shot');
    assert.equal(shotPrompts[0].body.prompt['8'].inputs.steps, 4, 'batch shots run with the 4-step fast tier');
    var shot2Call = shotPrompts[1].body.prompt;
    assert.match(shot2Call['17'].inputs.image, /^aics_video_input_[a-f0-9]{16}\.png$/,
      'shot 2 receives the chained first frame from shot 1 tail');
    assert.match(shot2Call['5'].inputs.prompt, /^For the target video, at 0\.00 seconds/,
      'chained shot 2 runs as I2VA');
    var shot3Call = shotPrompts[2].body.prompt;
    assert.equal(shot3Call['17'].inputs.image, shot3Name, 'shot 3 keeps its own keyframe as first frame');
    assert.match(shot3Call['18'].inputs.image, /^aics_video_input_[a-f0-9]{16}\.png$/,
      'shot 3 receives the chained tail frame as last_frame');
    assert.match(shot3Call['5'].inputs.prompt, /^How the reference pictures align with the target video/,
      'shot 3 runs as FL2VA with the official alignment instruction');

    // 拼接成片：至少两镜成功 → concat → Range 可读。
    var concatRes = await fetch(batchStack.baseUrl + '/api/video/batches/' + createdBatch.id + '/concat', {
      method:'POST',
    });
    assert.equal(concatRes.status, 200);
    var concatBatch = (await json(concatRes)).batch;
    assert.equal(concatBatch.concatAvailable, true);
    assert.ok(concatBatch.concatUrl);
    var concatGet = await fetch(batchStack.baseUrl + concatBatch.concatUrl, { headers:{ Range:'bytes=0-3' } });
    assert.equal(concatGet.status, 206);
    assert.equal((await concatGet.arrayBuffer()).byteLength, 4);

    // 重抽语义：只有失败/取消镜可重抽。
    var retryOk = await fetch(batchStack.baseUrl + '/api/video/batches/' + createdBatch.id + '/shots/2/retry', {
      method:'POST',
    });
    assert.equal(retryOk.status, 409, 'succeeded shots are not retryable');
  } finally {
    await batchStack.close();
  }
}

if (require.main === module) {
  run().then(function () {
    console.log('test-video-routes: ok');
  }).catch(function (error) {
    console.error(error);
    process.exitCode = 1;
  });
}

export = { run:run };
