import { ApiClientError, type ApiClient } from './client'
import { assertDirectImageRuntime, imageJob, jobPath, type DirectImageFamily } from './directImageJobs'
import { acceptDirectGenerationRequest, cancelDirectGenerationRequest, type DirectRequestOptions } from './directGenerationRequests'

type Family = DirectImageFamily
export const imageRequestPath = (family: Family, key: string) => jobPath(family).replace(/\/jobs$/, '/requests/') + encodeURIComponent(key)
function imageRequest(family: Family, key: string, input: Record<string, unknown> = {}) {
  return { key, submitPath: jobPath(family), receiptPath: imageRequestPath(family, key), body: input, field: 'job' as const,
    decode: (value: Record<string, unknown>) => {
      const id = (value.job as Record<string, unknown> | undefined)?.id
      if (typeof id !== 'string' || !id) throw new ApiClientError('图片接收任务编号无效', { kind: 'invalid-response' })
      return imageJob(value, id)
    } }
}
export function acceptDirectImageRequest(family: Family, input: Record<string, unknown>, key: string, options: DirectRequestOptions) {
  return acceptDirectGenerationRequest(imageRequest(family, key, input), options)
}
export async function cancelDirectImageRequest(family: Family, key: string, owner: string, client?: ApiClient) {
  assertDirectImageRuntime(owner)
  const result = await cancelDirectGenerationRequest(imageRequest(family, key), { client })
  assertDirectImageRuntime(owner)
  return result
}
