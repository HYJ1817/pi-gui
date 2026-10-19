import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const GATE_JOB_NAME = 'CI gate';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function proofError(code, message, details = {}) {
  return { ok: false, code, errors: [message], ...details };
}

function apiError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeSha(value) {
  const sha = String(value || '').toLowerCase();
  if (!SHA_RE.test(sha)) throw apiError('ci_sha_invalid', 'CI SHA must be a 40-character hexadecimal commit SHA.');
  return sha;
}

function validateRepo(repo) {
  if (!REPO_RE.test(String(repo || ''))) {
    throw apiError('github_repo_invalid', 'Repository must use owner/name form.');
  }
  return repo;
}

function summarizeRun(run) {
  return {
    id: run?.id ?? null,
    url: run?.html_url || null,
    headSha: run?.head_sha || null,
    headBranch: run?.head_branch || null,
    event: run?.event || null,
    path: run?.path || null,
    status: run?.status || null,
    conclusion: run?.conclusion ?? null,
  };
}

function summarizeGate(job) {
  return {
    id: job?.id ?? null,
    url: job?.html_url || null,
    headSha: job?.head_sha || null,
    status: job?.status || null,
    conclusion: job?.conclusion ?? null,
  };
}

function compareNewest(a, b) {
  const aTime = Date.parse(a?.created_at || '');
  const bTime = Date.parse(b?.created_at || '');
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  return Number(b?.id || 0) - Number(a?.id || 0);
}

async function readPages(api, firstEndpoint, collectionKey) {
  const first = await api(firstEndpoint);
  if (!Object.hasOwn(first || {}, 'total_count')
    || !Number.isSafeInteger(first.total_count)
    || first.total_count < 0
    || !Array.isArray(first?.[collectionKey])) {
    throw apiError('github_api_invalid', 'GitHub API returned an invalid paged response.');
  }
  const total = first.total_count;
  const items = [...first[collectionKey]];
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages > MAX_PAGES) throw apiError('github_api_unbounded', 'GitHub API result exceeds the bounded proof limit.');
  for (let page = 2; page <= pages; page += 1) {
    const next = await api(`${firstEndpoint}&page=${page}`);
    if (next?.total_count !== total || !Array.isArray(next?.[collectionKey])) {
      throw apiError('github_api_invalid', 'GitHub API returned an invalid continuation page.');
    }
    items.push(...next[collectionKey]);
  }
  if (items.length !== total) throw apiError('github_api_invalid', 'GitHub API page counts do not match total_count.');
  const ids = new Set();
  for (const item of items) {
    if (!Number.isSafeInteger(item?.id) || item.id <= 0 || ids.has(item.id)) {
      throw apiError('github_api_invalid', 'GitHub API returned duplicate or invalid item identities.');
    }
    ids.add(item.id);
  }
  return items;
}

export function createGitHubApi({ token, fetchImpl = globalThis.fetch, apiBaseUrl = 'https://api.github.com' } = {}) {
  if (!token) throw apiError('github_token_missing', 'GITHUB_TOKEN is required to verify CI.');
  if (typeof fetchImpl !== 'function') throw apiError('github_api_unavailable', 'No fetch implementation is available.');
  return async (endpoint) => {
    let response;
    try {
      response = await fetchImpl(`${apiBaseUrl}${endpoint}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw apiError('github_api_unavailable', 'GitHub API could not be reached.');
    }
    if (!response.ok) {
      throw apiError(
        response.status === 404 ? 'github_api_not_found' : 'github_api_unavailable',
        `GitHub API returned HTTP ${response.status}.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw apiError('github_api_invalid', 'GitHub API returned invalid JSON.');
    }
  };
}

export async function resolveTagCommit({ api, repo, tag }) {
  validateRepo(repo);
  if (!tag) throw apiError('tag_missing', 'Release tag is required.');
  let value;
  try {
    value = await api(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error?.code === 'github_api_not_found') throw apiError('tag_not_found', `Tag ${tag} does not exist.`);
    throw error;
  }
  let type = value?.object?.type;
  let sha = String(value?.object?.sha || '').toLowerCase();
  for (let depth = 0; type === 'tag' && depth < 8; depth += 1) {
    if (!SHA_RE.test(sha)) throw apiError('tag_unresolved', `Tag ${tag} does not contain a valid object SHA.`);
    let object;
    try {
      object = await api(`/repos/${repo}/git/tags/${sha}`);
    } catch (error) {
      if (error?.code === 'github_api_not_found') throw apiError('tag_unresolved', `Annotated tag ${tag} could not be dereferenced.`);
      throw error;
    }
    type = object?.object?.type;
    sha = String(object?.object?.sha || '').toLowerCase();
  }
  if (type !== 'commit' || !SHA_RE.test(sha)) {
    throw apiError('tag_unresolved', `Tag ${tag} does not resolve to a commit.`);
  }
  return sha;
}

async function fetchJobs(api, repo, runId) {
  return readPages(
    api,
    `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=${PAGE_SIZE}`,
    'jobs',
  );
}

/**
 * Prove that the tag, checkout SHA, successful push CI, and final CI gate all
 * identify the same commit. The caller may skip duplicate source tests only when
 * this function returns ok:true.
 */
export async function verifyCiProof({ tag, sha, repo, api } = {}) {
  try {
    const expectedSha = normalizeSha(sha);
    const repository = validateRepo(repo);
    if (!api) throw apiError('github_api_unavailable', 'GitHub API reader is required.');

    const tagCommitSha = await resolveTagCommit({ api, repo: repository, tag });
    if (tagCommitSha !== expectedSha) {
      return proofError(
        'tag_sha_mismatch',
        `Tag ${tag} points to ${tagCommitSha}, not checked-out SHA ${expectedSha}.`,
        { tag, sha: expectedSha, tagCommitSha },
      );
    }

    const runs = await readPages(
      api,
      `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${expectedSha}&branch=main&event=push&per_page=${PAGE_SIZE}`,
      'workflow_runs',
    );
    if (!runs.length) {
      return proofError('ci_run_missing', `No main push CI run exists for ${expectedSha}.`, { tag, sha: expectedSha });
    }
    if (runs.some((item) => !Number.isSafeInteger(item?.run_attempt)
      || item.run_attempt <= 0
      || !Number.isFinite(Date.parse(item?.created_at || '')))) {
      return proofError('ci_run_schema_invalid', 'GitHub CI results do not contain a valid run identity.', {
        tag,
        sha: expectedSha,
        tagCommitSha,
      });
    }

    const latest = [...runs].sort(compareNewest)[0];
    const latestSummary = summarizeRun(latest);
    if (latest?.head_sha !== expectedSha
      || latest?.head_branch !== 'main'
      || latest?.event !== 'push'
      || String(latest?.path || '').split('@')[0] !== WORKFLOW_PATH) {
      return proofError(
        'ci_identity_mismatch',
        'The newest CI run does not match the exact SHA, main push event, and ci.yml workflow.',
        { tag, sha: expectedSha, tagCommitSha, run: latestSummary },
      );
    }
    if (latest.status !== 'completed') {
      return proofError('ci_incomplete', `Exact-SHA CI is ${latest.status || 'not completed'}.`, {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary,
      });
    }
    if (latest.conclusion !== 'success') {
      return proofError('ci_failed', `Exact-SHA CI concluded ${latest.conclusion || 'without success'}.`, {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary,
      });
    }

    const jobs = await fetchJobs(api, repository, latest.id);
    const gates = jobs.filter((job) => job?.name === GATE_JOB_NAME);
    if (gates.length === 0) {
      return proofError('ci_gate_missing', 'The successful CI run has no final CI gate job.', {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary,
      });
    }
    if (gates.length !== 1) {
      return proofError('ci_gate_ambiguous', 'The latest CI attempt contains multiple final CI gate jobs.', {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary,
      });
    }
    const finalGate = gates[0];
    const gateSummary = summarizeGate(finalGate);
    if (finalGate.head_sha !== expectedSha) {
      return proofError('ci_gate_identity_mismatch', 'The final CI gate belongs to a different commit.', {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary, gate: gateSummary,
      });
    }
    if (finalGate.status !== 'completed') {
      return proofError('ci_gate_incomplete', `The final CI gate is ${finalGate.status || 'not completed'}.`, {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary, gate: gateSummary,
      });
    }
    if (finalGate.conclusion !== 'success') {
      return proofError('ci_gate_failed', `The final CI gate concluded ${finalGate.conclusion || 'without success'}.`, {
        tag, sha: expectedSha, tagCommitSha, run: latestSummary, gate: gateSummary,
      });
    }

    return {
      ok: true,
      tag,
      sha: expectedSha,
      tagCommitSha,
      run: latestSummary,
      gate: gateSummary,
    };
  } catch (error) {
    return proofError(
      error?.code || 'ci_proof_unavailable',
      error?.message || 'The exact-SHA CI proof could not be established.',
    );
  }
}

export async function verifyCheckoutCiProof({
  tag,
  checkoutSha,
  expectedEventSha,
  repo,
  api,
} = {}) {
  try {
    const checkout = normalizeSha(checkoutSha);
    const eventSha = normalizeSha(expectedEventSha);
    if (checkout !== eventSha) {
      return proofError(
        'event_sha_mismatch',
        `Workflow event SHA ${eventSha} does not match checkout HEAD ${checkout}.`,
        { tag, checkoutSha: checkout, expectedEventSha: eventSha },
      );
    }
    return await verifyCiProof({ tag, sha: checkout, repo, api });
  } catch (error) {
    return proofError(
      error?.code || 'ci_proof_unavailable',
      error?.message || 'The release checkout identity could not be verified.',
    );
  }
}

function parseArgs(argv) {
  const options = {
    tag: argv.find((item) => item.startsWith('--tag='))?.slice('--tag='.length) || null,
    sha: argv.find((item) => item.startsWith('--sha='))?.slice('--sha='.length) || null,
    expectedSha: argv.find((item) => item.startsWith('--expected-sha='))?.slice('--expected-sha='.length)
      || process.env.EXPECTED_SHA
      || null,
    repo: argv.find((item) => item.startsWith('--repo='))?.slice('--repo='.length)
      || process.env.GITHUB_REPOSITORY
      || null,
  };
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let api;
  try {
    api = createGitHubApi({ token: process.env.GITHUB_TOKEN });
  } catch (error) {
    const result = proofError(error.code, error.message);
    console.error(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  const result = await verifyCheckoutCiProof({
    tag: options.tag,
    checkoutSha: options.sha,
    expectedEventSha: options.expectedSha,
    repo: options.repo,
    api,
  });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
