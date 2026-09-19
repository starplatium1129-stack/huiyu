import { describe, expect, it } from 'vitest'
import { captureResultContext, type ResultContextInput } from './resultContext'

function input() {
  return {
    subject: { kind: 'popular' as const, characterId: 'popular-a', outfitId: 'outfit-a', blueprintId: 'blueprint-a' },
    sceneId: 'scene-a', story: '  original story  ', char: 'nene' as const,
    visualDescription: 'original description',
    selections: { emotion: ['calm'], shot: 'medium', lighting: 'window', composition: 'center' },
    colorMood: 'soft', manualTags: ['river'], artistStyleIds: ['style-a'], directorMode: 'pro' as const, projectId: 'project-a',
  }
}

describe('结果快照的窄输入契约', () => {
  it('普通对象直接捕获身份、故事、风格与项目，不创建 Store', () => {
    expect(captureResultContext(input())).toEqual({
      characterId: 'popular-a', outfitId: 'outfit-a', blueprintId: 'blueprint-a', sceneId: 'scene-a', story: 'original story', char: 'nene',
      history: { visualDescription: 'original description', emotion: ['calm'], shot: 'medium', lighting: 'window', composition: 'center',
        colorMood: 'soft', manual_tags: ['river'], artistStyleIds: ['style-a'], project: 'project-a' },
    })
  })

  it('提交后原对象的身份、嵌套选择与数组修改不污染已捕获结果', () => {
    const source = input()
    const snapshot = captureResultContext(source)
    source.subject.characterId = 'popular-b'
    source.subject.outfitId = 'outfit-b'
    source.subject.blueprintId = 'blueprint-b'
    source.selections.emotion.push('happy')
    source.selections.shot = 'close'
    source.manualTags.push('forest')
    source.artistStyleIds.push('style-b')
    source.story = 'later story'
    source.projectId = 'project-b'
    expect(snapshot).toMatchObject({ characterId: 'popular-a', outfitId: 'outfit-a', blueprintId: 'blueprint-a', story: 'original story',
      history: { emotion: ['calm'], shot: 'medium', manual_tags: ['river'], artistStyleIds: ['style-a'], project: 'project-a' } })
  })

  it('接受冻结的只读输入，工作室与基础模式保留缺省语义', () => {
    const source: ResultContextInput = Object.freeze({
      ...input(), subject: Object.freeze({ kind: 'studio' as const }), story: '', sceneId: null, directorMode: 'basic',
      selections: Object.freeze({ emotion: Object.freeze(['calm']), shot: null, lighting: null, composition: null }),
      manualTags: Object.freeze(['river']), artistStyleIds: Object.freeze(['style-a']),
    })
    expect(captureResultContext(source)).toMatchObject({ characterId: '', outfitId: null, blueprintId: null, sceneId: null, story: '',
      history: { emotion: ['calm'], manual_tags: ['river'], artistStyleIds: [] } })
  })

  it('沿用工作台手动标签的 Set 输入，保持插入顺序并复制集合', () => {
    const tags = new Set(['river', 'forest'])
    const snapshot = captureResultContext({ ...input(), manualTags: tags })
    tags.delete('river')
    tags.add('sky')
    expect(snapshot.history?.manual_tags).toEqual(['river', 'forest'])
  })
})
