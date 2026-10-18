/** One byte limit for both directions; never offer a file this version rejects. */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024
export const BACKUP_SIZE_MESSAGE = '备份文件超过 512 MB，暂不支持直接恢复；请先分批导出原图'
