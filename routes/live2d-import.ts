import express from 'express'
const { localOnly }: typeof import('../server/security') = require('../server/security')
import { addLocalImport, editImportProfile, getImportProfile } from '../services/live2d-import-editor'

/** Mounted under the ordinary gateway authentication/CSRF middleware. */
export function createLive2dImportRouter(root: string) {
  const router = express.Router()
  router.use('/api/live2d-import', localOnly)
  const fail = (res: express.Response, error: any) => res.status(error?.status === 409 ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Import failed' })
  router.post('/api/live2d-import', express.raw({ type: 'multipart/form-data', limit: '256mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error('Multipart model files required')
      const form = await new Request('http://localhost/import', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: new Uint8Array(req.body) }).formData()
      const metadata = JSON.parse(String(form.get('metadata')))
      const paths = JSON.parse(String(form.get('paths')))
      const files = form.getAll('files')
      if (!metadata || typeof metadata !== 'object' || !Array.isArray(paths) || files.length !== paths.length || files.length > 512) throw new Error('Invalid upload manifest')
      const uploads = await Promise.all(files.map(async (file, index) => {
        if (typeof file === 'string' || file.size > 64 * 1024 * 1024) throw new Error('Invalid model file')
        return { path: paths[index], bytes: Buffer.from(await file.arrayBuffer()) }
      }))
      res.status(201).json(addLocalImport(root, metadata, uploads))
    } catch (error) { fail(res, error) }
  })
  router.get('/api/live2d-import/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json(getImportProfile(root, String(req.params.id))) } catch (error) { fail(res, error) }
  })
  router.use('/api/live2d-import/:id', express.json({ limit: '96kb' }))
  router.put('/api/live2d-import/:id', (req, res) => {
    try { res.json(editImportProfile(root, String(req.params.id), req.body || {}, 'save')) } catch (error) { fail(res, error) }
  })
  router.post('/api/live2d-import/:id/rollback', (req, res) => {
    try { res.json(editImportProfile(root, String(req.params.id), req.body || {}, 'rollback')) } catch (error) { fail(res, error) }
  })
  router.delete('/api/live2d-import/:id', (req, res) => {
    try { res.json(editImportProfile(root, String(req.params.id), req.body || {}, 'disable')) } catch (error) { fail(res, error) }
  })
  router.use('/api/live2d-import', ((error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : 400
    res.status(status).json({ error: status === 413 ? 'Model upload exceeds size limit' : 'Invalid import request body' })
  }) as express.ErrorRequestHandler)
  return router
}
