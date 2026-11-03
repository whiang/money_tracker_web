// 비공개 GitHub 저장소의 JSON 파일 하나를 가계부 DB로 쓴다 (GitHub REST API, contents).
// 토큰은 이 기기 브라우저(localStorage)에만 두고, 코드나 저장소에는 넣지 않는다.

import { ApiError } from './ledger.js';

const API = 'https://api.github.com';

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHubStore {
  // repo: 'owner/name'
  constructor({ token, repo, path = 'ledger.json', fetchImpl }) {
    this.token = token;
    this.repo = repo;
    this.path = path;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.etag = null;
  }

  url(suffix = '') { return `${API}/repos/${this.repo}${suffix}`; }

  async call(url, { method = 'GET', body, accept = 'application/vnd.github+json', headers = {} } = {}) {
    let res;
    try {
      res = await this.fetch(url, {
        method, cache: 'no-store',
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28',
                   ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'GitHub에 연결할 수 없습니다 (인터넷 연결을 확인하세요)');
    }
    if (res.status === 401) throw new ApiError(401, 'GitHub 토큰이 맞지 않거나 만료되었습니다');
    if (res.status === 403 || res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const limited = res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429;
      throw new ApiError(403, limited ? 'GitHub 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요'
        : `GitHub 권한이 없습니다 (토큰의 Contents 읽기·쓰기 권한 확인): ${data.message || ''}`);
    }
    return res;
  }

  async load() {
    const res = await this.call(this.url(`/contents/${this.path}`));
    if (res.status === 404) {
      // 파일이 없는 것인지, 저장소에 접근할 수 없는 것인지 구분한다
      const repo = await this.call(this.url());
      if (!repo.ok) throw new ApiError(401, `저장소 ${this.repo}를 찾을 수 없습니다 (이름과 토큰 권한 확인)`);
      this.etag = null;
      return { data: null, sha: null };
    }
    if (!res.ok) throw new ApiError(res.status, `GitHub에서 읽지 못했습니다 (${res.status})`);
    this.etag = res.headers.get('etag');
    const meta = await res.json();
    let text;
    if (meta.content && meta.encoding === 'base64') text = fromBase64(meta.content);
    else {
      // 1MB가 넘는 파일은 내용 없이 오므로 원본으로 다시 받는다
      const raw = await this.call(this.url(`/contents/${this.path}`), { accept: 'application/vnd.github.raw+json' });
      if (!raw.ok) throw new ApiError(raw.status, `GitHub에서 읽지 못했습니다 (${raw.status})`);
      text = await raw.text();
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new ApiError(500, `${this.path}가 올바른 JSON이 아닙니다`); }
    return { data, sha: meta.sha };
  }

  // 저장소의 파일이 sha와 다르면 true. ETag가 같으면(304) 요청 한도도 쓰지 않는다.
  async changed(sha) {
    const res = await this.call(this.url(`/contents/${this.path}`),
      { headers: this.etag ? { 'If-None-Match': this.etag } : {} });
    if (res.status === 304) return false;
    if (res.status === 404) return sha !== null;
    if (!res.ok) throw new ApiError(res.status, `GitHub에서 읽지 못했습니다 (${res.status})`);
    const meta = await res.json();
    if (meta.sha === sha) this.etag = res.headers.get('etag');
    return meta.sha !== sha;
  }

  async save(data, sha, message) {
    const res = await this.call(this.url(`/contents/${this.path}`), {
      method: 'PUT',
      body: { message, content: toBase64(JSON.stringify(data, null, 1) + '\n'), ...(sha ? { sha } : {}) },
    });
    if (res.status === 409 || res.status === 422) {
      throw Object.assign(new ApiError(409, '다른 기기에서 먼저 저장했습니다. 다시 시도하세요'), { conflict: true });
    }
    if (!res.ok) throw new ApiError(res.status, `GitHub에 저장하지 못했습니다 (${res.status})`);
    this.etag = null;  // 다음 확인 때 새 ETag를 받는다
    return (await res.json()).content.sha;
  }
}
