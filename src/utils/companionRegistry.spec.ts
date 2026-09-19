import { describe, expect, it, beforeEach } from 'vitest'
import {
  getCompanionCharacter,
  getCompanionAvatar,
  getCompanionProfile,
  listCompanionCharacters,
  listCompanionAvatars,
  registerCompanionCharacter,
  registerCompanionAvatar,
  resolveCompanionAvatar,
  resetCompanionRegistryForTesting,
} from './companionRegistry'
import type { Live2DAdapterProfile } from '@/live2d/adapterProfile'

describe('Companion Character Registry (Plan 010 C0/C2)', () => {
  beforeEach(() => {
    resetCompanionRegistryForTesting()
  })

  it('initializes built-in characters Nene and Natsume with verified profiles', () => {
    const nene = getCompanionCharacter('nene')
    expect(nene).toBeDefined()
    expect(nene?.name).toBe('绫地宁宁')
    expect(nene?.defaultAvatarId).toBe('avatar-nene-default')

    const natsume = getCompanionCharacter('natsume')
    expect(natsume).toBeDefined()
    expect(natsume?.name).toBe('四季夏目')

    const neneProfile = getCompanionProfile('profile-nene-v1')
    expect(neneProfile).toBeDefined()
    expect(neneProfile?.parameterBindings.mouth.id).toBe('ParamMouthOpenY')

    const natsumeProfile = getCompanionProfile('profile-natsume-v1')
    expect(natsumeProfile).toBeDefined()
    expect(natsumeProfile?.parameterBindings.mouth.id).toBe('ParamMouthForm3')
    expect(natsumeProfile?.overlaySettle?.resetDefaults['Param37']).toBe(-1)
    expect(natsumeProfile?.overlaySettle?.resetDefaults['Param18']).toBe(0)
  })

  it('rejects unknown character IDs cleanly without falling back to nene', () => {
    const unknown = getCompanionCharacter('unknown_char')
    expect(unknown).toBeUndefined()

    const resolved = resolveCompanionAvatar('unknown_char')
    expect(resolved).toBeNull()
  })

  it('supports registering a third fixture character and avatar without modifying core views (C2 requirement)', () => {
    const fixtureChar = {
      id: 'fixture_murasame',
      name: '丛雨',
      defaultAvatarId: 'avatar-murasame-default',
      tags: ['fixture', 'spirit'],
    }
    registerCompanionCharacter(fixtureChar)

    const fixtureProfile: Live2DAdapterProfile = {
      schemaVersion: 1,
      profileId: 'profile-murasame-v1',
      profileVersion: '1.0.0',
      avatarId: 'avatar-murasame-default',
      backendCompatibility: ['browser'],
      parameterBindings: {
        mouth: { id: 'ParamMouthOpenY', scale: 1 },
        blink: ['ParamEyeLOpen', 'ParamEyeROpen'],
      },
      verification: {
        status: 'needs-confirmation',
        reason: 'Third party fixture model pending full calibration',
      },
    }

    registerCompanionAvatar({
      id: 'avatar-murasame-default',
      characterId: 'fixture_murasame',
      name: '神剑立绘',
      modelPath: '/live2d/murasame/murasame.model3.json',
      version: '1.0.0',
      profileId: fixtureProfile.profileId,
    }, fixtureProfile)

    const resolved = resolveCompanionAvatar('fixture_murasame')
    expect(resolved).not.toBeNull()
    expect(resolved?.character.id).toBe('fixture_murasame')
    expect(resolved?.character.name).toBe('丛雨')
    expect(resolved?.avatar.id).toBe('avatar-murasame-default')
    expect(resolved?.profile.profileId).toBe('profile-murasame-v1')
    expect(resolved?.profile.verification.status).toBe('needs-confirmation')

    const allChars = listCompanionCharacters()
    expect(allChars.map(c => c.id)).toContain('fixture_murasame')
  })

  it('supports multiple avatars under a single character definition', () => {
    const altProfile: Live2DAdapterProfile = {
      schemaVersion: 1,
      profileId: 'profile-nene-casual',
      profileVersion: '1.0.0',
      avatarId: 'avatar-nene-casual',
      backendCompatibility: ['browser'],
      parameterBindings: {
        mouth: { id: 'ParamMouthOpenY', scale: 1 },
        blink: ['ParamEyeLOpen', 'ParamEyeROpen'],
      },
      verification: { status: 'verified' },
    }

    registerCompanionAvatar({
      id: 'avatar-nene-casual',
      characterId: 'nene',
      name: '私服冬装',
      modelPath: '/live2d/nene_casual/nene.model3.json',
      version: '1.0.0',
      profileId: altProfile.profileId,
    }, altProfile)

    const neneAvatars = listCompanionAvatars('nene')
    expect(neneAvatars.length).toBe(2)
    expect(neneAvatars.map(a => a.id)).toContain('avatar-nene-casual')

    const resolvedCasual = resolveCompanionAvatar('nene', 'avatar-nene-casual')
    expect(resolvedCasual?.avatar.name).toBe('私服冬装')
    expect(resolvedCasual?.character.name).toBe('绫地宁宁')
  })

  it('rejects registering an avatar pointing to an unknown characterId', () => {
    expect(() => {
      registerCompanionAvatar({
        id: 'avatar-orphan',
        characterId: 'non_existent_character',
        name: '孤立外观',
        modelPath: '/test.json',
        version: '1.0.0',
        profileId: 'some-profile',
      })
    }).toThrow(/unknown characterId/)
  })
})
