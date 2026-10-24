import { onActivated, onDeactivated, onScopeDispose, watch } from 'vue';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import type { ResultRestoreOwner } from '@/composables/generation/animaSessionContract';
import { imageMediaSession } from '@/platform/imageMediaSession';
import { onDesktopRuntime } from '@/platform/desktop/runtime';
import { runtimeResourceIdentity } from '@/platform/runtimeUrl';
/**
 * Owns the restore-visit lifecycle of the prompt workspace: a pending result
 * restore stays current only while the same visit, media session and route
 * survive. KeepAlive deactivation, route changes and desktop runtime identity
 * switches renew or abort the visit so a late restore never lands elsewhere.
 */
export function useResultRestoreOwner(route: RouteLocationNormalizedLoaded) {
    let disposed = false;
    let interrogateActive = true;
    let restoreVisit = new AbortController();
    let restoreMediaSession = imageMediaSession();
    function renewRestoreVisit() { restoreVisit.abort(); restoreVisit = new AbortController(); }
    function refreshRestoreMedia() {
        const next = imageMediaSession();
        if (next !== restoreMediaSession) { restoreMediaSession = next; renewRestoreVisit(); }
    }
    const stopRestoreRuntime = onDesktopRuntime(refreshRestoreMedia);
    watch(runtimeResourceIdentity, refreshRestoreMedia, { flush: 'sync' });
    watch(() => JSON.stringify([route.path, route.query]), renewRestoreVisit, { flush: 'sync' });
    onActivated(() => { interrogateActive = true; if (restoreVisit.signal.aborted) restoreVisit = new AbortController(); });
    onDeactivated(() => { interrogateActive = false; restoreVisit.abort(); });
    onScopeDispose(() => { disposed = true; restoreVisit.abort(); stopRestoreRuntime(); }, true);
    function getRestoreOwner(): ResultRestoreOwner {
        const visit = restoreVisit, session = imageMediaSession();
        return { signal: visit.signal, current: () => !disposed && interrogateActive && route.path === '/prompt-builder' && restoreVisit === visit && session === imageMediaSession() };
    }
    return {
        getRestoreOwner,
        isDisposed: () => disposed,
        isInterrogateActive: () => interrogateActive,
    };
}
