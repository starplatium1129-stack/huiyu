// Shared transport for the two isolated inpaint candidate tools. Workflow construction stays with each tool.

function comfyJson(base: any, method: any, pathname: any, body: any, timeoutMs: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const url = new URL(base.replace(/\/$/, '') + pathname);
    const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const request = client.request({
      hostname: url.hostname, port: url.port, method,
      path: url.pathname + url.search, timeout: timeoutMs || 30000,
      headers: Object.assign({ Accept: 'application/json' }, payload ? {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
      } : {}),
    }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
      response.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const raw = rawBuffer.toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (error) { /* keep null */ }
        resolve({ status: response.statusCode || 0, data, raw, rawBuffer });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ComfyUI request timeout')));
    if (payload) request.write(payload);
    request.end();
  });
}

async function uploadImage(comfyBase: any, filename: any, buffer: any) {
  const boundary = `----aics${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, buffer, suffix]);
  const url = new URL(comfyBase.replace(/\/$/, '') + '/upload/image');
  const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
  return new Promise<any>((resolve: any, reject: any) => {
    const request = client.request({
      hostname: url.hostname, port: url.port, method: 'POST', timeout: 60000,
      path: url.pathname + '?overwrite=true',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (error) { /* keep null */ }
        resolve({ status: response.statusCode || 0, data, raw });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ComfyUI upload timeout')));
    request.write(payload);
    request.end();
  });
}

function resolveUploadName(requested: any, uploaded: any) {
  const serverName = uploaded && uploaded.data && uploaded.data.name;
  return serverName || requested;
}

async function submitAndWait(comfyBase: any, workflow: any, clientId: string, timeoutMs: number, pollMs: number) {
  const submitted = await comfyJson(comfyBase, 'POST', '/prompt', { prompt: workflow, client_id: clientId }, 30000);
  if (submitted.status < 200 || submitted.status >= 300 || !submitted.data || !submitted.data.prompt_id) {
    throw new Error(`ComfyUI prompt submission failed (HTTP ${submitted.status}): ${submitted.raw || JSON.stringify(submitted.data)}`);
  }
  const promptId = submitted.data.prompt_id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await comfyJson(comfyBase, 'GET', `/history/${encodeURIComponent(promptId)}`, null, 15000);
    const entry = history.data && history.data[promptId];
    if (entry) {
      const status = entry.status && entry.status.status_str;
      if (status === 'error' || status === 'failed') {
        const messages = (entry.status && entry.status.messages || [])
          .filter(([, value]: any) => value && value.exception_message)
          .map(([, value]: any) => value.exception_message);
        throw new Error(`ComfyUI execution failed for ${promptId}: ${messages.join(' | ') || JSON.stringify(entry.status)}`);
      }
      if (status === 'success') return { promptId, entry };
    }
    await new Promise<any>((resolve: any) => setTimeout(resolve, pollMs));
  }
  throw new Error(`ComfyUI execution timed out for ${promptId}`);
}

async function fetchOutputImage(comfyBase: any, image: any) {
  const query = `?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=output`;
  const response = await comfyJson(comfyBase, 'GET', '/view' + query, null, 60000);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ComfyUI /view failed (HTTP ${response.status})`);
  }
  return response.rawBuffer;
}

export = { comfyJson, uploadImage, resolveUploadName, submitAndWait, fetchOutputImage };
