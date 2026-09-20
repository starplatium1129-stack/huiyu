import type { Request } from 'express';
import crypto = require('node:crypto');
import fs = require('node:fs');
import express = require('express');
import security = require('../server/security');
import envelope = require('../server/http-envelope');
import { errorCode, errorMessage, errorStatus } from '../scripts/lib/runtime-errors';
import { createGenerationService, type GenerationDependencies } from '../server/generation/service';
import type { GenerationConfig } from '../server/generation/types';
import { validate } from '../server/generation/validation';
import { buildWorkflow } from '../server/generation/workflow';
import { normalizeCheckpointName, isWaiCheckpoint, availableSuperRes } from '../server/generation/resources';
import { MAX_BODY, CHECKPOINT, LORAS, SAMPLERS, COMFY_SUPERRES_FILES } from '../server/generation/constants';
function owner(req: Request) {
    if (security.isDirectLocalRequest(req))
        return 'local';
    let cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
    let token = req.headers['x-token'] || cookie && cookie[1] || req.query && req.query.token || '';
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function createGenerationRouter(config: GenerationConfig, dependencies?: GenerationDependencies) {
    const service = createGenerationService(config, dependencies);
    const router = express.Router();
    const limit = security.rateLimit({ capacity: 12, refillMs: 5000, label: 'WAI 出图' });
    router.get('/api/generation/status', async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        return envelope.ok(res, await service.getStatus());
    });
    router.post('/api/generation/jobs', limit, express.json({ limit: MAX_BODY }), async (req, res) => {
        let input;
        try {
            input = validate(req, req.body);
        }
        catch (e) {
            return envelope.fail(res, errorStatus(e) || 400, errorMessage(e), { code: errorCode(e) });
        }
        try {
            return res.status(202).json({ ok: true, job: await service.submit(input, owner(req)) });
        }
        catch (e) {
            return envelope.fail(res, errorStatus(e) || 502, errorMessage(e), { code: errorCode(e) });
        }
    });
    router.get('/api/generation/jobs/:id', (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            return envelope.ok(res, { job: service.getJob(req.params.id, owner(req)) });
        }
        catch (e) {
            return envelope.fail(res, errorStatus(e) || 500, errorMessage(e), { code: errorCode(e) });
        }
    });
    router.get('/api/generation/jobs/:id/result', (req, res) => {
        try {
            const result = service.getResult(req.params.id, owner(req));
            res.setHeader('Content-Type', result.mime);
            if (result.kind === 'buffer') {
                res.setHeader('Content-Length', String(result.buffer.length));
                res.end(result.buffer);
                result.consume();
                return;
            }
            res.setHeader('Content-Length', String(result.bytes));
            const stream = fs.createReadStream(result.file);
            stream.on('error', () => { if (!res.headersSent)
                envelope.fail(res, 404, '结果不存在', { code: 'RESULT_NOT_FOUND' });
            else
                res.destroy(); });
            res.once('finish', result.consume);
            stream.pipe(res);
        }
        catch (e) {
            return envelope.fail(res, errorStatus(e) || 500, errorMessage(e), { code: errorCode(e) });
        }
    });
    router.delete('/api/generation/jobs/:id', async (req, res) => {
        try {
            return envelope.ok(res, { job: await service.cancel(req.params.id, owner(req)) });
        }
        catch (e) {
            return envelope.fail(res, errorStatus(e) || 500, errorMessage(e), { code: errorCode(e) });
        }
    });
    return { router, service: service.comfy, close: service.close };
}
// Compatibility exports for existing gateway fixtures and callers.
export = { createGenerationRouter, validateInput: validate, buildWorkflow, normalizeCheckpointName, isWaiCheckpoint, availableSuperRes, constants: { CHECKPOINT, LORAS, SAMPLERS, COMFY_SUPERRES_FILES } };
