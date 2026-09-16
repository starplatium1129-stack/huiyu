import { confirmAction } from '@/composables/useConfirm';
import { artworkRepository } from '@/storage/artworkRepository';
import { type ArtworkRecord } from '@/types/artwork';
import { storageWriteMessage } from '@/utils/storageWriteError';
import type { useGalleryWorkspace } from './useGalleryWorkspace';
type Context = Pick<ReturnType<typeof useGalleryWorkspace>, "showToast" | "deleting" | "viewerIndex" | "visible" | "indexOf" | "history" | "releaseCardResources" | "pendingDeleteId" | "closeViewer" | "openViewer" | "bulkDeleting" | "selectedIds" | "loadGalleryStorage">;
interface FavoriteWrite {
    tail: Promise<void>;
    confirmed: boolean;
    revision: number;
}
const favoriteWrites = new WeakMap<object, Map<string | number, FavoriteWrite>>();
export async function toggleFavoriteAction(ctx: Pick<Context, 'history' | 'showToast'>, item: ArtworkRecord): Promise<void> {
    let writes = favoriteWrites.get(ctx.history);
    if (!writes) {
        writes = new Map();
        favoriteWrites.set(ctx.history, writes);
    }
    let state = writes.get(item.id);
    if (!state) {
        state = { tail: Promise.resolve(), confirmed: Boolean(item.favorite), revision: 0 };
        writes.set(item.id, state);
    }
    const currentWrite = state;
    const revision = ++state.revision;
    const desired = !item.favorite;
    item.favorite = desired;
    // Serialize writes for this artwork while immediately reflecting the latest click.
    state.tail = state.tail.then(async () => {
        try {
            const result = await artworkRepository.patchArtwork(item.id, { favorite: desired });
            if (!result.updated)
                throw new Error('没找到这幅作品，收藏没能保存');
            currentWrite.confirmed = desired;
        }
        catch (error) {
            if (revision === currentWrite.revision)
                item.favorite = currentWrite.confirmed;
            ctx.showToast(storageWriteMessage(error, '收藏状态'), 'error');
        }
        finally {
            if (revision === currentWrite.revision)
                writes.delete(item.id);
        }
    });
    await state.tail;
}
export async function confirmDeleteAction(ctx: Context, item: ArtworkRecord): Promise<void> {
    const { showToast, deleting, viewerIndex, visible, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer } = ctx;
    if (deleting.value)
        return;
    deleting.value = true;
    try {
        const wasOpen = viewerIndex.value >= 0;
        const removedIndex = visible.value.indexOf(item);
        // Repository 先完成跨库删除与补偿回滚，再改界面；失败时界面不动作。
        const result = await artworkRepository.softDeleteArtwork(item.id);
        if (!result.deleted) {
            showToast('这幅作品已不在作品册，请刷新后重试', 'warning');
            return;
        }
        history.value = history.value.filter(h => h.id !== item.id);
        releaseCardResources(item.id);
        pendingDeleteId.value = null;
        // 查看器开着就顺移到下一幅，删到空则关闭
        if (wasOpen) {
            if (!visible.value.length)
                closeViewer();
            else
                openViewer(Math.min(Math.max(removedIndex, 0), visible.value.length - 1));
        }
        showToast('已移入回收站，30 天内可撤销', 'info', 5000, {
            label: '撤销',
            onClick: () => { void undoDeleteAction(ctx, item); },
        });
    }
    catch (e) {
        console.warn('delete artwork failed', e);
        showToast('删除失败，请重试');
    }
    finally {
        deleting.value = false;
    }
}
export async function bulkDeleteAction(ctx: Context): Promise<void> {
    const { showToast, viewerIndex, releaseCardResources, closeViewer, bulkDeleting, selectedIds, loadGalleryStorage } = ctx;
    if (bulkDeleting.value || !selectedIds.value.size)
        return;
    const count = selectedIds.value.size;
    const ok = await confirmAction({
        title: `把 ${count} 幅作品移入回收站？`,
        message: '它们会立即从展墙消失，但原图保留 30 天，可在提示里一键撤销。',
        confirmLabel: '移入回收站',
        danger: true,
    });
    if (!ok)
        return;
    bulkDeleting.value = true;
    const ids = [...selectedIds.value];
    const failed: (string | number)[] = [];
    try {
        for (const id of ids) {
            try {
                const result = await artworkRepository.softDeleteArtwork(id);
                if (!result.deleted)
                    failed.push(id);
            }
            catch {
                failed.push(id);
            }
        }
        const done = ids.length - failed.length;
        if (done) {
            // 查看器可能正指着被删掉的某一幅，先收起来，避免停在一张空图上
            if (viewerIndex.value >= 0)
                closeViewer();
            // 软删已在仓储层摘掉项目引用，整体重载一次即可同步展墙与项目下拉
            for (const id of ids)
                if (!failed.includes(id))
                    releaseCardResources(id);
            selectedIds.value = new Set(failed);
            await loadGalleryStorage();
        }
        if (failed.length) {
            showToast(done
                ? `${done} 幅已移入回收站，${failed.length} 幅没成功，请重试`
                : `一幅都没能移进去，请重试`, 'warning', 5000);
        }
        else {
            showToast(`${done} 幅已移入回收站，30 天内可撤销`, 'info', 6000, {
                label: '撤销',
                onClick: () => { void undoBulkDeleteAction(ctx, ids); },
            });
        }
    }
    finally {
        bulkDeleting.value = false;
    }
}
export async function undoBulkDeleteAction(ctx: Context, ids: (string | number)[]): Promise<void> {
    const { showToast, loadGalleryStorage } = ctx;
    let restored = 0;
    let missingImages = 0;
    for (const id of ids) {
        try {
            const result = await artworkRepository.restoreArtwork(id);
            if (result.restored)
                restored += 1;
            else if (result.missingImageIds?.length)
                missingImages += 1;
        }
        catch { /* 逐条继续，不因一条失败放弃其余 */ }
    }
    await loadGalleryStorage();
    showToast(restored
        ? `已把 ${restored} 幅放回展墙${missingImages ? `，${missingImages} 幅因原图缺失未恢复` : ''}`
        : missingImages ? `${missingImages} 幅原图已缺失，无法完整恢复；回收站快照仍保留` : '这些作品已不在回收站，无法恢复',
    restored ? 'success' : 'warning');
}
export async function undoDeleteAction(ctx: Context, item: ArtworkRecord): Promise<void> {
    const { showToast, loadGalleryStorage } = ctx;
    try {
        const result = await artworkRepository.restoreArtwork(item.id);
        if (!result.restored) {
            showToast(result.missingImageIds?.length
                ? '原图已缺失，无法完整恢复；回收站快照仍保留'
                : '这条作品已不在回收站，无法恢复', 'warning');
            return;
        }
        await loadGalleryStorage();
        showToast('已恢复到作品册');
    }
    catch (e) {
        console.warn('restore artwork failed', e);
        showToast('恢复失败，请重试');
    }
}
