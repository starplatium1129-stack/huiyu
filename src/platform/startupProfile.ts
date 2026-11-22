import { shallowRef } from 'vue'

export const startupProfilePending = shallowRef(false)
let initialProfile: Promise<unknown> = Promise.resolve()

export function setStartupProfile(pending: Promise<unknown>) {
  startupProfilePending.value = true
  const current = pending.finally(() => {
    if (current === initialProfile) startupProfilePending.value = false
  })
  void current.catch(() => {})
  initialProfile = current
}

export function whenStartupProfileReady() { return initialProfile }
