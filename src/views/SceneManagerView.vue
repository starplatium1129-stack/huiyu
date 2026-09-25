<template>
  <article class="page scene-maintenance-page" :class="{ 'is-catalog': tab === 'scenes' || tab === 'blueprints' }" style="--page-max:1640px">
    <WorkspaceArchiveBar
      chapter="12"
      title="SCENE MAINTENANCE"
      :subtitle="`${scenes.length || '—'} RECORDS · ${tab.toUpperCase()}`"
      :status="loading ? 'READING ARCHIVE' : (loadError ? 'ARCHIVE EXCEPTION' : (saving ? 'WRITING PROJECT' : (dirty ? 'UNSAVED CHANGES' : 'ARCHIVE SYNCED')))"
      :state="loading ? 'active' : (loadError ? 'warning' : (saving ? 'active' : (dirty ? 'warning' : 'success')))"
      shape="frame"
    />
    <header class="sm-head">
      <div>
        <div class="page-kicker">Scene manager</div>
        <h1 class="title">场景维护</h1>
        <div class="maintenance-state" :class="{ dirty: dirty }">
          <strong id="maintenanceTitle">{{ loading ? '正在读取场景档案' : (loadError ? '场景档案暂不可用' : (dirty ? '有尚未保存的修改' : '已同步')) }}</strong>
          <span v-if="!desktopPackaged" id="maintenanceHint" role="status" aria-live="polite">{{ loading ? '正在同步磁盘数据…' : (loadError || maintenanceHint) }}</span>
          <span v-if="saving && savingPhase" class="saving-phase">{{ savingPhase }}</span>
        </div>
      </div>
      <div class="sm-head-actions">
        <button class="btn btn-ghost" type="button" :disabled="loading || saving || desktopPackaged || toolRunning || previewing" @click="loadFromStore(true)">重新读取</button>
        <button class="btn btn-ghost" type="button" @click="exportJSON" :disabled="loading"><ArchiveIcon name="download" /> 导出 JSON</button>
        <button class="btn btn-ghost" type="button" :disabled="!canPreview" @click="tab = 'tools'; previewChanges()"><ArchiveIcon name="eye" /> 影响预览</button>
        <StudioTooltip anchor :content="desktopPackaged ? '桌面应用模式不支持保存场景内容' : undefined">
          <button class="btn btn-primary" type="button" :disabled="!canSave" @click="saveToProject">
            {{ saving ? '正在保存…' : (desktopPackaged ? '桌面模式不可保存' : '保存到项目') }}
          </button>
        </StudioTooltip>
      </div>
    </header>

    <ArchiveStatePanel
      v-if="loading"
      kind="loading"
      title="正在读取场景档案"
      message="正在从本地数据源同步场景、标签和维护记录。"
    />

    <p v-if="desktopPackaged" class="manager-readonly" role="status"><ArchiveIcon name="eye" />桌面只读模式：可查看完整内容、复制和导出；编辑与保存请在开发工作区中进行。</p>

    <ArchiveStatePanel
      v-if="!loading && loadError"
      kind="error"
      title="场景档案读取失败"
      :message="`${loadError} 请确认本地服务正常运行且场景数据完好。`"
    >
      <button class="btn btn-primary" type="button" @click="loadFromStore(true)">重新读取</button>
    </ArchiveStatePanel>

    <template v-if="!loading && !loadError">
      <SceneStatsSummary :scenes-count="scenes.length" :stats="stats" />
      <div class="manager-workspace">
      <nav class="manager-nav" aria-label="维护分区">
        <span class="manager-nav-heading">内容与维护</span>
        <button v-for="t in TABS" :key="t.id" type="button" :aria-pressed="tab === t.id" @click="tab = t.id"><span>{{ t.label }}</span><small v-if="recordCounts[t.id] !== undefined">{{ recordCounts[t.id] }}</small></button>
        <p>选择记录查看详情。编辑后先保存草稿，再保存到项目。</p>
      </nav>
      <div class="manager-content">
      <MaintenanceCatalog v-show="tab === 'scenes'" :records="sceneRecords" kind="scene" label="场景" :readonly="desktopPackaged" @add="openAddModal" @edit="openEditModal" @duplicate="duplicateScene" @remove="deleteScene" />
      <MaintenanceCatalog v-show="tab === 'blueprints'" :records="blueprintRecords" kind="blueprint" label="蓝图" :readonly="desktopPackaged" @add="openBlueprintAddModal" @edit="openBlueprintEditModal" @duplicate="duplicateBlueprint" @remove="deleteBlueprint" />

      <!-- 标签库 -->
      <template v-if="tab==='tags'">
        <div class="toolbar">
          <input v-model="tagSearch" class="search-input" type="search" aria-label="搜索标签（英文、中文或分类）" placeholder="搜索标签（英文/中文/分类）…" />
          <StudioSelect v-model="tagCatFilter" class="filter-select" label="标签分类" :options="[{ value: '', label: '全部分类' }, ...tagCats.map(c => ({ value: c, label: c }))]" />
          <button class="btn btn-ghost btn-sm" type="button" :disabled="desktopPackaged" @click="startAddTag">＋ 新增标签</button>
          <span class="list-meta">{{ filteredTags.length }} / {{ tags.length }} 个</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>分类</th><th>英文</th><th>中文</th><th>权重</th><th>使用</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-if="!filteredTags.length" class="table-state-row">
                <td colspan="7">
                  <ArchiveStatePanel compact kind="filtered" title="没有匹配的标签" message="调整筛选条件，或新建一个标签。" />
                </td>
              </tr>
              <tr v-for="t in pagedTags" :key="t.id">
                <td><code class="id-code">{{ t.id }}</code></td>
                <td>{{ t.cat }}</td>
                <td><span class="tag-chip" v-html="hl(t.en, tagSearchDebounced)"></span></td>
                <td>{{ t.cn }}</td>
                <td>{{ t.weight }}</td>
                <td>{{ tagUsage[t.en] || 0 }}</td>
                <td>
                  <div class="action-btns">
                    <button class="btn btn-ghost btn-sm" type="button" :disabled="desktopPackaged" @click="startEditTag(t.id)">编辑</button>
                    <button class="btn btn-danger btn-sm" type="button" :disabled="desktopPackaged" @click="deleteTag(t.id)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="tagTotalPages > 1" class="pagination">
          <button class="btn btn-ghost btn-sm" :disabled="tagPage <= 1" @click="tagPage--">← 上一页</button>
          <span class="hint-sm">{{ tagPage }} / {{ tagTotalPages }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="tagPage >= tagTotalPages" @click="tagPage++">下一页 →</button>
        </div>
      </template>

      <!-- 样张管理 -->
      <template v-if="tab==='images'">
        <section class="home-hero-maintenance">
          <div class="toolbar">
            <strong>首页主视觉</strong>
            <span class="list-meta">当前首页右侧的宁宁 / 夏目两张图，可单独替换</span>
          </div>
          <p class="note">上传后会归一化为 JPEG 并写入本机 SceneShowcase；首页刷新后立即生效。点击“恢复内置图”可回退到项目自带版本。</p>
          <div class="image-grid home-hero-grid">
            <button v-for="hero in homeHeroes" :key="hero.id" class="sm-image-card" type="button" :class="{ active: selectedHeroId === hero.id }" @click="previewHero(hero)">
              <span class="sm-card-id">首页 · {{ hero.id }}</span>
              <span class="sm-card-title">{{ hero.title }}</span>
              <span class="sm-card-meta">{{ hero.updatedAt ? `已替换 ${hero.updatedAt}` : '使用内置图' }}</span>
            </button>
          </div>
          <div v-if="selectedHeroId" class="image-preview">
            <div class="image-preview-head">
              <strong>首页 · {{ selectedHeroTitle }}</strong>
              <span class="row-tight">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="uploadBusy || desktopPackaged" @click="pickHero">上传 / 替换</button>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="uploadBusy || desktopPackaged" @click="resetHero">恢复内置图</button>
                <button class="btn btn-ghost btn-sm" type="button" @click="selectedHeroId = ''">关闭</button>
              </span>
            </div>
            <img class="image-preview-img home-hero-preview" :src="heroUrl" :alt="selectedHeroTitle" />
            <input ref="heroFileEl" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onHeroPicked" />
            <p class="image-feedback" :class="{ err: showcaseError }">{{ showcaseFeedback }}</p>
          </div>
        </section>
        <div class="toolbar">
          <input v-model="imageSearch" class="search-input" type="search" aria-label="搜索场景、蓝图、角色或标题" placeholder="搜索场景/蓝图 ID、标题、角色…" />
          <StudioSelect v-model="imageTypeFilter" class="filter-select" label="样张类型" :options="[
            { value: 'all', label: '全部样张 (' + allShowcaseItems.length + ')' },
            { value: 'scene', label: '经典主线场景 (' + scenes.length + ')' },
            { value: 'popular', label: '热门角色蓝图 (' + (allShowcaseItems.length - scenes.length) + ')' },
          ]" />
          <span class="list-meta">{{ filteredImageScenes.length }} 个场景/蓝图</span>
        </div>
        <p class="note">点选任意主线场景或热门角色蓝图查看当前样张，支持直接上传替换。图片会自动归一化为标准 JPEG 并更新官方 Manifest，刷新后即时生效。</p>
        <div class="image-grid">
          <button
            v-for="s in pagedImageScenes" :key="s.id"
            class="sm-image-card" type="button"
            :class="{ active: selectedImageId === s.id }"
            @click="previewImage(s)"
          >
            <img :src="`/scene-showcase/thumbs/${encodeURIComponent(s.id)}.jpg?v=${showcaseVersion}`" loading="lazy" class="sm-card-thumb" @error="onThumbError" alt="" />
            <span class="sm-card-id">{{ s.id }}</span>
            <span class="sm-card-title">{{ s.title }}</span>
            <span class="sm-card-meta">{{ charLabel(s.char) }} · {{ s.rating || 'All' }}</span>
          </button>
        </div>
        <div v-if="imageTotalPages > 1" class="pagination">
          <button class="btn btn-ghost btn-sm" :disabled="imagePage <= 1" @click="imagePage--">← 上一页</button>
          <span class="hint-sm">{{ imagePage }} / {{ imageTotalPages }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="imagePage >= imageTotalPages" @click="imagePage++">下一页 →</button>
        </div>

        <div v-if="selectedImageId" class="image-preview">
          <div class="image-preview-head">
            <strong>{{ selectedImageId }} · {{ selectedImageTitle }}</strong>
            <span class="row-tight">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="uploadBusy || desktopPackaged" @click="pickShowcase">上传 / 替换样张</button>
              <button class="btn btn-ghost btn-sm" type="button" @click="selectedImageId = ''">关闭</button>
            </span>
          </div>
          <img class="image-preview-img" :src="showcaseUrl" :alt="selectedImageTitle" @error="onShowcaseMissing" />
          <input ref="showcaseFileEl" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onShowcasePicked" />
          <p class="image-feedback" :class="{ err: showcaseError }">{{ showcaseFeedback }}</p>
        </div>
      </template>

      <!-- 重复检测 -->
      <template v-if="tab==='duplicates'">
        <div class="toolbar">
          <button class="btn btn-primary btn-sm" type="button" @click="detectDuplicates">开始检测</button>
          <span class="list-meta">{{ dupResult }}</span>
        </div>
        <p class="note">按关键词分组，同一关键词命中 3 个以上场景会列出，便于合并或下架冗余场景。</p>
        <ArchiveStatePanel
          v-if="!dupGroups.length"
          compact
          :kind="dupChecked ? 'success' : 'empty'"
          :title="dupChecked ? '未发现明显重复' : '尚未开始检测'"
          :message="dupChecked ? '当前场景库没有命中三条以上的重复关键词。' : '按关键词分组，快速定位可合并或下架的冗余场景。'"
        />
        <div v-for="g in dupGroups" :key="g.keyword" class="dup-group">
          <h4>「{{ g.keyword }}」· {{ g.scenes.length }} 个场景</h4>
          <div v-for="s in g.scenes" :key="s.id" class="dup-item">
            <span>
              <strong>{{ s.id }}</strong> {{ s.title }}
              <span class="rating-badge" :class="'rating-' + (s.rating || 'All')">{{ s.rating || 'All' }}</span>
            </span>
            <div class="action-btns">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="desktopPackaged" @click="openEditModal(s.id)">编辑</button>
              <button class="btn btn-danger btn-sm" type="button" :disabled="desktopPackaged" @click="deleteSceneFromDup(s.id)">下架</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 导入 -->
      <template v-if="tab==='import'">
        <p class="note">粘贴单个或多个场景 JSON（数组或对象），校验后加入列表。记得保存到项目。</p>
        <textarea v-model="importInput" class="import-input" aria-label="场景导入 JSON" rows="10" placeholder='[{ "id":"sc1000", "title":"…", "story":"…", "char":"nene", "rating":"All" }]'></textarea>
        <div class="import-actions">
          <button class="btn btn-primary" type="button" :disabled="desktopPackaged || importing || toolRunning" @click="importScenes">校验并导入</button>
          <button class="btn btn-ghost" type="button" :disabled="desktopPackaged || importing || toolRunning" @click="loadFullSnapshot">载入完整快照草稿</button>
          <button class="btn btn-ghost" type="button" @click="importInput=''; importResult=''">清空</button>
        </div>
        <div v-if="importResult" class="import-result" v-html="importResult"></div>
        <p class="note">普通导入仅追加新场景。完整快照须含场景、蓝图、标签和策展，载入时替换内存草稿；保存前可用顶部“影响预览”核对退役及引用。</p>
        <button v-if="fullImportLoaded" class="btn btn-danger" type="button" :disabled="!canSave || importing" @click="importSnapshotToProject">全量导入到项目</button>
      </template>

      <!-- 维护工具 -->
      <template v-if="tab==='tools'">
        <SceneImpactPreview :preview="preview" :groups="previewGroups" :companions="previewCompanions" :busy="previewing" :enabled="canPreview" :error="previewError" :invalidated="previewInvalidated" :empty="previewEmpty" @preview="previewChanges" />
        <div class="tool-grid">
          <StudioTooltip v-for="t in TOOLS" :key="t.id" anchor :content="desktopPackaged ? '桌面应用模式不支持维护任务' : undefined">
            <button class="sm-tool-card" type="button" :disabled="toolRunning || desktopPackaged || saving || previewing" @click="runTool(t.id)">
              <div class="sm-tool-icon"><ArchiveIcon :name="t.iconName" /></div>
              <div class="sm-tool-label">{{ t.label }}</div>
              <div class="sm-tool-desc">{{ t.desc }}</div>
            </button>
          </StudioTooltip>
        </div>
        <div v-if="toolResult" class="tool-result-panel">
          <div class="tool-result-head">
            <strong>{{ toolResultTitle }}</strong>
            <span class="badge" :class="toolResult.ok ? 'badge-success' : 'badge-danger'">{{ toolResult.ok ? '通过' : '有问题' }}</span>
            <span v-if="!toolResult.ok" class="tool-error-hint">可按高亮的完整场景编号定位失败场景</span>
          </div>
          <pre class="tool-output" v-html="highlightedOutput"></pre>
        </div>
        <section class="backup-history">
          <div class="backup-history-head">
            <strong>备份历史</strong>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="backupsLoading" @click="loadBackups">{{ backupsLoading ? '读取中…' : '查看备份历史' }}</button>
          </div>
          <p class="note">展示最近 50 份维护备份（按创建时间倒序），只读清单，便于核对保存前后的备份编号。</p>
          <p v-if="backupsError" class="form-hint" role="alert">{{ backupsError }}</p>
          <template v-if="backupsExpanded">
            <ArchiveStatePanel v-if="!backups.length && !backupsError" compact kind="empty" title="暂无备份" message="尚未产生任何维护备份，保存一次场景内容后会自动创建。" />
            <ul v-else-if="backups.length" class="backup-list">
              <li v-for="b in backups" :key="b.id" class="backup-item">
                <code class="id-code">{{ b.id }}</code>
                <span class="backup-label">{{ b.label || '—' }}</span>
                <span class="backup-meta">{{ formatBackupTime(b.createdAt) }} · {{ b.fileCount }} 文件</span>
              </li>
            </ul>
          </template>
        </section>
      </template>
      </div>
      </div>
    </template>

    <!-- 编辑 Modal -->
    <Teleport to="body">
      <FluidTransition>
      <div v-if="editing" class="overlay" @click.self="closeModal">
        <div
          ref="modalEl"
          class="modal-card modal-card-wide"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scene-editor-title"
        >
          <h2 id="scene-editor-title">{{ editingId ? '编辑场景 · ' + editing.id : '新增场景' }}</h2>
          <fieldset class="form-section">
            <legend class="form-legend">基础信息</legend>
            <div class="form-grid">
              <label class="form-group"><span class="field-label">ID</span><input v-model="editing.id" class="input" :disabled="!!editingId || desktopPackaged" placeholder="sc001" /></label>
              <label class="form-group"><span class="field-label">标题 *</span><input v-model="editing.title" class="input" :disabled="desktopPackaged" required :aria-invalid="!editing.title.trim() && triedSave" :class="{invalid: !editing.title.trim() && triedSave}" /></label>
              <label class="form-group"><span class="field-label">分类</span><input v-model="editing.category" class="input" :disabled="desktopPackaged" placeholder="恋爱 / 日常 / 校园…" /></label>
              <label class="form-group">
                <span class="field-label">角色</span>
                <StudioSelect v-model="editing.char" class="filter-select" label="角色" :disabled="desktopPackaged" @update:model-value="updateCharacterDefaults" :options="[{ value: 'nene', label: '宁宁' }, { value: 'natsume', label: '夏目' }, { value: 'triad', label: '双人' }]" />
              </label>
              <label class="form-group"><span class="field-label">LoRA</span><input v-model="editing.lora" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group">
                <span class="field-label">分级</span>
                <StudioSelect v-model="editing.rating" class="filter-select" label="分级" :disabled="desktopPackaged" :options="[{ value: 'All', label: 'All' }, { value: 'R15', label: 'R15' }, { value: 'R18', label: 'R18' }]" />
              </label>
            </div>
          </fieldset>

          <fieldset class="form-section">
            <legend class="form-legend">叙事信息</legend>
            <div class="form-grid">
              <label class="form-group form-group-full"><span class="field-label">故事 *</span><textarea v-model="editing.story" class="input" :disabled="desktopPackaged" rows="3" required :aria-invalid="!editing.story.trim() && triedSave" :class="{invalid: !editing.story.trim() && triedSave}"></textarea></label>
              <label class="form-group form-group-full"><span class="field-label">故事日文</span><textarea v-model="editing.storyJa" class="input" :disabled="desktopPackaged" rows="2"></textarea></label>
              <label class="form-group"><span class="field-label">地点</span><input v-model="editing.location" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">天气</span><input v-model="editing.weather" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">镜头</span><input v-model="editing.camera" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">光照</span><input v-model="editing.lighting" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">季节</span><input v-model="editing.season" class="input" :disabled="desktopPackaged" placeholder="春/夏/秋/冬/不限" /></label>
              <label class="form-group"><span class="field-label">时段</span><input v-model="editing.time" class="input" :disabled="desktopPackaged" placeholder="清晨/白天/黄昏/深夜" /></label>
              <label class="form-group"><span class="field-label">timeOfDay</span><input v-model="editing.timeOfDay" class="input" :disabled="desktopPackaged" placeholder="morning/noon/late_night" /></label>
            </div>
          </fieldset>

          <fieldset class="form-section">
            <legend class="form-legend">视觉标签</legend>
            <div class="form-grid">
              <label class="form-group form-group-full"><span class="field-label">标签（逗号分隔）</span><input v-model="tagsInput" class="input" :disabled="desktopPackaged" placeholder="silk, looking_back,…" /></label>
              <label class="form-group form-group-full"><span class="field-label">用途（逗号分隔）</span><input v-model="usageInput" class="input" :disabled="desktopPackaged" placeholder="壁纸, 表情包" /></label>
              <label class="form-group form-group-full"><span class="field-label">画面提示词</span><textarea v-model="editing.prompt" class="input" :disabled="desktopPackaged" rows="2"></textarea></label>
              <label class="form-group form-group-full"><span class="field-label">负面提示词</span><textarea v-model="editing.negative" class="input input-mono" :disabled="desktopPackaged" rows="2"></textarea></label>
              <label class="form-group"><span class="field-label">情绪</span><input v-model="editing.emotion" class="input" :disabled="desktopPackaged" /></label>
            </div>
          </fieldset>

          <fieldset class="form-section">
            <legend class="form-legend">策展信息</legend>
            <div class="form-grid">
              <label class="form-group">
                <span class="field-label">策展层级</span>
                <StudioSelect v-model="curationTierValue" class="filter-select" label="策展层级" :disabled="desktopPackaged" @update:model-value="onCurationTierChange" :options="[{ value: 'normal', label: '普通' }, { value: 'review', label: '待审' }, { value: 'curated', label: '精选' }, { value: 'signature', label: '招牌' }]" />
              </label>
              <label class="form-group form-group-full"><span class="field-label">推荐理由（招牌必填）</span><input v-model="curationReason" class="input" :disabled="desktopPackaged || curationTierValue==='normal'||curationTierValue==='review'" :aria-invalid="curationTierValue==='signature' && !curationReason.trim() && triedSave" :class="{invalid: curationTierValue==='signature' && !curationReason.trim() && triedSave}" /></label>
            </div>
          </fieldset>
          <p v-if="formHint" id="scene-form-hint" class="form-hint" role="alert">{{ formHint }}</p>
          <div class="modal-actions">
            <button class="btn btn-primary" type="button" @click="saveScene">保存</button>
            <button class="btn btn-ghost" type="button" @click="copyJson">复制 JSON</button>
            <button class="btn btn-ghost" type="button" @click="closeModal">取消</button>
          </div>
          <p class="note-sm">注意：修改仅在内存中生效，需点"保存到项目"写回 data/scenes.json</p>
        </div>
      </div>
      </FluidTransition>
    </Teleport>

    <!-- 蓝图编辑 Modal -->
    <Teleport to="body">
      <FluidTransition>
      <div v-if="bpEditing" class="overlay" @click.self="closeBlueprintModal">
        <div
          ref="bpModalEl"
          class="modal-card modal-card-wide"
          role="dialog"
          aria-modal="true"
          aria-labelledby="blueprint-editor-title"
        >
          <h2 id="blueprint-editor-title">{{ bpEditingId ? '编辑蓝图 · ' + bpEditing.id : '新增蓝图' }}</h2>
          <fieldset class="form-section">
            <legend class="form-legend">基础信息</legend>
            <div class="form-grid">
              <label class="form-group"><span class="field-label">ID *</span><input v-model="bpEditing.id" class="input" :disabled="!!bpEditingId || desktopPackaged" placeholder="bp_001 / character_scene" /></label>
              <label class="form-group"><span class="field-label">标题 *</span><input v-model="bpEditing.title" class="input" :disabled="desktopPackaged" required :aria-invalid="!bpEditing.title.trim() && bpTriedSave" :class="{invalid: !bpEditing.title.trim() && bpTriedSave}" /></label>
              <label class="form-group"><span class="field-label">角色 *</span><input v-model="bpEditing.characterId" class="input" :disabled="desktopPackaged" required :aria-invalid="!bpEditing.characterId?.trim() && bpTriedSave" :class="{invalid: !bpEditing.characterId?.trim() && bpTriedSave}" placeholder="raiden_shogun / nene" /></label>
              <label class="form-group"><span class="field-label">分类</span><input v-model="bpEditing.category" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">服装 outfitId</span><input v-model="bpEditing.outfitId" class="input" :disabled="desktopPackaged" placeholder="default / school / witch…" /></label>
              <label class="form-group">
                <span class="field-label">样张定级</span>
                <StudioSelect v-model="bpEditing.sampleRating" class="filter-select" label="样张定级" :disabled="desktopPackaged" :options="[{ value: 'All', label: 'All' }, { value: 'R15', label: 'R15' }, { value: 'R18', label: 'R18' }]" />
              </label>
              <ToggleSwitch v-model="bpEditing.adult" :disabled="desktopPackaged" class="form-group form-check" label="成人蓝图（adult）"><span>成人蓝图（adult）</span></ToggleSwitch>
              <label class="form-group form-group-full"><span class="field-label">描述</span><textarea v-model="bpEditing.description" class="input" :disabled="desktopPackaged" rows="2"></textarea></label>
            </div>
          </fieldset>

          <fieldset class="form-section">
            <legend class="form-legend">场景要素</legend>
            <div class="form-grid">
              <label class="form-group"><span class="field-label">地点</span><input v-model="bpEditing.location" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">动作</span><input v-model="bpEditing.action" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">时段</span><input v-model="bpEditing.timeOfDay" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">光照</span><input v-model="bpEditing.lighting" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">镜头</span><input v-model="bpEditing.camera" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">情绪</span><input v-model="bpEditing.mood" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group form-group-full"><span class="field-label">场景标签（逗号分隔）</span><input v-model="bpSceneTagsInput" class="input" :disabled="desktopPackaged" placeholder="inazuma, shoji, night…" /></label>
              <label class="form-group form-group-full"><span class="field-label">推荐尺寸</span><input v-model="bpEditing.recommendedSize" class="input" :disabled="desktopPackaged" placeholder="832x1216 / 1024x1024" /></label>
            </div>
          </fieldset>

          <fieldset class="form-section">
            <legend class="form-legend">Prompt 数据（核心）</legend>
            <div class="form-grid">
              <label class="form-group form-group-full"><span class="field-label">Krea 散文 promptProse</span><textarea v-model="bpEditing.promptProse" class="input" :disabled="desktopPackaged" rows="4"></textarea></label>
              <label class="form-group form-group-full"><span class="field-label">Anima 标签 promptTokens（逗号分隔）*</span><textarea v-model="bpPromptTokensInput" class="input input-mono" :disabled="desktopPackaged" rows="3" required></textarea></label>
              <label class="form-group form-group-full"><span class="field-label">负面 negativeTokens（逗号分隔）*</span><textarea v-model="bpNegativeTokensInput" class="input input-mono" :disabled="desktopPackaged" rows="3" required></textarea></label>
            </div>
          </fieldset>

          <fieldset class="form-section">
            <legend class="form-legend">风格 / 成人扩展</legend>
            <div class="form-grid">
              <label class="form-group"><span class="field-label">Krea 风格 hint</span><input v-model="bpEditing.kreaStyleHint" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group"><span class="field-label">Anima 风格 hint</span><input v-model="bpEditing.animaStyleHint" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group form-group-full"><span class="field-label">成人画师提示</span><input v-model="bpEditing.adultArtistHint" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group form-group-full"><span class="field-label">NSFW 标签（逗号分隔）</span><input v-model="bpNsfwTokensInput" class="input" :disabled="desktopPackaged" /></label>
              <label class="form-group form-group-full"><span class="field-label">NSFW 散文</span><textarea v-model="bpEditing.nsfwProse" class="input" :disabled="desktopPackaged" rows="2"></textarea></label>
              <label class="form-group form-group-full"><span class="field-label">验收覆盖 coverageTags（逗号分隔）</span><input v-model="bpCoverageTagsInput" class="input" :disabled="desktopPackaged" placeholder="iconic, daily, special_nsfw" /></label>
            </div>
          </fieldset>

          <p v-if="bpFormHint" class="form-hint" role="alert">{{ bpFormHint }}</p>
          <div class="modal-actions">
            <button class="btn btn-primary" type="button" @click="saveBlueprint">保存</button>
            <button class="btn btn-ghost" type="button" @click="copyBlueprintJson">复制 JSON</button>
            <button class="btn btn-ghost" type="button" @click="closeBlueprintModal">取消</button>
          </div>
          <p class="note-sm">注意：修改仅在内存中生效，需点“保存到项目”写回 data/scene-blueprints.json</p>
        </div>
      </div>
      </FluidTransition>
    </Teleport>

    <!-- 标签表单 Modal -->
    <Teleport to="body">
      <FluidTransition>
      <div v-if="tagModalOpen" class="overlay" @click.self="closeTagModal">
        <div
          ref="tagModalEl"
          class="modal-card modal-card-tag"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="tagEditing ? 'tag-editor-title-edit' : 'tag-editor-title-add'"
        >
          <h2 :id="tagEditing ? 'tag-editor-title-edit' : 'tag-editor-title-add'">{{ tagEditing ? '编辑标签 · ' + tagEditing.id : '新增标签' }}</h2>
          <div class="form-grid form-grid-single">
            <label class="form-group">
              <span class="field-label">英文名 *</span>
              <input v-model="tagForm.en" class="input" :disabled="desktopPackaged" placeholder="Danbooru 格式，用下划线" />
            </label>
            <label class="form-group">
              <span class="field-label">中文名 *</span>
              <input v-model="tagForm.cn" class="input" :disabled="desktopPackaged" placeholder="标签中文名" />
            </label>
            <label class="form-group">
              <span class="field-label">分类 *</span>
              <StudioSelect v-model="tagForm.cat" class="filter-select" label="分类" :disabled="desktopPackaged" :options="tagCats.map(c => ({ value: c, label: c }))" />
            </label>
            <label class="form-group">
              <span class="field-label">权重 * (0–2)</span>
              <input v-model.number="tagForm.weight" class="input" :disabled="desktopPackaged" type="number" :min="0" :max="2" :step="0.1" />
            </label>
          </div>
          <p v-if="tagFormError" class="form-hint" role="alert">{{ tagFormError }}</p>
          <div class="modal-actions">
            <button class="btn btn-primary" type="button" @click="submitTag">{{ tagEditing ? '保存' : '新增' }}</button>
            <button class="btn btn-ghost" type="button" @click="closeTagModal">取消</button>
          </div>
        </div>
      </div>
      </FluidTransition>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import WorkspaceArchiveBar from '@/components/visual/WorkspaceArchiveBar.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import MaintenanceCatalog from '@/components/maintenance/MaintenanceCatalog.vue'
import SceneImpactPreview from '@/components/maintenance/SceneImpactPreview.vue'
import SceneStatsSummary from '@/components/maintenance/SceneStatsSummary.vue'
import { useSceneManagerWorkspace } from "@/composables/scene/useSceneManagerWorkspace"
const {
canSave, canPreview, preview, previewing, previewError, previewInvalidated, previewEmpty,
previewCompanions, previewGroups, previewChanges, fullImportLoaded, importing, loadFullSnapshot, importSnapshotToProject,
 tagModalEl,bpModalEl,modalEl,showcaseFileEl,heroFileEl,tab, scenes, loading, loadError, saving, dirty,
desktopPackaged, maintenanceHint, savingPhase, exportJSON, saveToProject, loadFromStore,
stats, TABS, recordCounts, sceneRecords, openAddModal, openEditModal,
duplicateScene, deleteScene, blueprintRecords, openBlueprintAddModal, openBlueprintEditModal, duplicateBlueprint,
deleteBlueprint, tagSearch, tagCatFilter, tagCats, startAddTag, filteredTags,
tags, pagedTags, hl, tagSearchDebounced, tagUsage, startEditTag,
deleteTag, tagTotalPages, tagPage, homeHeroes, selectedHeroId, previewHero,
selectedHeroTitle, uploadBusy, pickHero, resetHero, heroUrl, onHeroPicked,
showcaseError, showcaseFeedback, imageSearch, imageTypeFilter, allShowcaseItems, filteredImageScenes,
pagedImageScenes, selectedImageId, previewImage, showcaseVersion, onThumbError, charLabel,
imageTotalPages, imagePage, selectedImageTitle, pickShowcase, showcaseUrl, onShowcaseMissing,
onShowcasePicked, detectDuplicates, dupResult, dupGroups, dupChecked, deleteSceneFromDup,
importInput, importScenes, importResult, TOOLS, toolRunning, runTool,
toolResult, toolResultTitle, highlightedOutput, backupsLoading, loadBackups, backupsError,
backupsExpanded, backups, formatBackupTime, editing, closeModal, editingId,
triedSave, updateCharacterDefaults, tagsInput, usageInput, curationTierValue, onCurationTierChange,
curationReason, formHint, saveScene, copyJson, bpEditing, closeBlueprintModal,
bpEditingId, bpTriedSave, bpSceneTagsInput, bpPromptTokensInput, bpNegativeTokensInput, bpNsfwTokensInput,
bpCoverageTagsInput, bpFormHint, saveBlueprint, copyBlueprintJson, tagModalOpen, closeTagModal,
tagEditing, tagForm, tagFormError, submitTag,
} = useSceneManagerWorkspace()
</script>

<style scoped src="@/assets/css/scene-manager-view.css"></style>
