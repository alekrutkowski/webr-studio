import { basename, normalizePath } from './utils.js?v=1.2.12';

const API_ROOT = 'https://api.github.com';

function headers(token = '') {
  const result = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) result.Authorization = `Bearer ${token.trim()}`;
  return result;
}

async function githubRequest(path, options = {}, token = '') {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.message || `GitHub returned HTTP ${response.status}`;
    const details = body?.errors?.map(error => error.message || JSON.stringify(error)).join('; ');
    throw new Error(details ? `${message}: ${details}` : message);
  }
  return body;
}

export function gistIdFromReference(reference) {
  const value = String(reference || '').trim().replace(/\/+$/, '');
  if (/^[a-f0-9]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!/gist\.github\.com$/i.test(url.hostname)) return '';
    return url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    return '';
  }
}

export async function importGist(reference, token = '') {
  const id = gistIdFromReference(reference);
  if (!id) throw new Error('Enter a valid GitHub Gist URL or ID.');
  const gist = await githubRequest(`/gists/${id}`, {}, token);
  const files = [];
  for (const file of Object.values(gist.files || {})) {
    let content = file.content || '';
    if (file.truncated && file.raw_url) {
      const rawUrl = new URL(file.raw_url);
      if (!['gist.githubusercontent.com', 'raw.githubusercontent.com'].includes(rawUrl.hostname)) {
        throw new Error(`GitHub returned an unexpected raw-content host for ${file.filename}.`);
      }
      const response = await fetch(rawUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`Could not download the complete content of ${file.filename}.`);
      content = await response.text();
    }
    files.push({
      path: normalizePath(file.filename),
      content,
      type: 'text',
      mime: file.type || 'text/plain',
      size: new TextEncoder().encode(content).length
    });
  }
  return {
    id: gist.id,
    description: gist.description || '',
    public: Boolean(gist.public),
    url: gist.html_url,
    owner: gist.owner?.login || '',
    files
  };
}

export async function createGist({ description = '', isPublic = false, files = [], token }) {
  if (!token?.trim()) throw new Error('A GitHub personal access token is required to create a gist.');
  if (!files.length) throw new Error('Select at least one text file.');
  const gistFiles = {};
  const usedNames = new Set();
  for (const file of files) {
    let filename = basename(file.path);
    if (usedNames.has(filename)) filename = normalizePath(file.path).replaceAll('/', '__');
    usedNames.add(filename);
    gistFiles[filename] = { content: String(file.content ?? '') };
  }
  return githubRequest('/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, public: Boolean(isPublic), files: gistFiles })
  }, token);
}
