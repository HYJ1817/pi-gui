const assert = require('node:assert/strict');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(` FAIL  ${name}: ${error.message}`);
  }
}

function run({
  id = 101,
  sha = SHA_A,
  branch = 'main',
  event = 'push',
  path = '.github/workflows/ci.yml',
  status = 'completed',
  conclusion = 'success',
  createdAt = '2026-10-19T10:00:00Z',
  attempt = 1,
} = {}) {
  return { id, run_attempt: attempt, head_sha: sha, head_branch: branch, event, path, status, conclusion, created_at: createdAt, html_url: `https://github.test/runs/${id}` };
}

function gate({
  id = 201,
  sha = SHA_A,
  status = 'completed',
  conclusion = 'success',
  name = 'CI gate',
} = {}) {
  return { id, name, head_sha: sha, status, conclusion, html_url: `https://github.test/jobs/${id}` };
}

function fakeApi({
  ref = { object: { type: 'commit', sha: SHA_A, url: 'https://api.github.test/tag-object' } },
  runs = [run()],
  jobs = [gate()],
  fail = null,
} = {}) {
  const requests = [];
  const api = async (endpoint) => {
    requests.push(endpoint);
    if (fail && endpoint.includes(fail.match)) throw Object.assign(new Error('fixture API unavailable'), { code: 'github_api_unavailable' });
    if (endpoint.includes('/git/ref/tags/')) return ref;
    if (endpoint.includes('/actions/workflows/ci.yml/runs')) return { total_count: runs.length, workflow_runs: runs };
    if (endpoint.includes('/actions/runs/') && endpoint.includes('/jobs')) return { total_count: jobs.length, jobs };
    throw new Error(`unexpected fixture endpoint: ${endpoint}`);
  };
  return { api, requests };
}

(async () => {
  let createGitHubApi;
  let verifyCheckoutCiProof;
  let verifyCiProof;
  try {
    ({ createGitHubApi, verifyCheckoutCiProof, verifyCiProof } = await import('../scripts/verify-ci-proof.mjs'));
  } catch (error) {
    console.error(` FAIL  verifier module available: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  await check('exact tag commit with successful push CI and CI gate passes', async () => {
    const fixture = fakeApi();
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.run.id, 101);
    assert.equal(result.gate.id, 201);
    assert.ok(fixture.requests.some((url) => url.includes('head_sha=' + SHA_A)));
    assert.ok(fixture.requests.some((url) => url.includes('branch=main')));
    assert.ok(fixture.requests.some((url) => url.includes('event=push')));
    assert.ok(fixture.requests.some((url) => url.includes('filter=latest')));
  });

  await check('annotated tag is resolved to its commit before matching CI', async () => {
    const calls = [];
    const api = async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.includes('/git/ref/tags/')) return { object: { type: 'tag', sha: 'c'.repeat(40) } };
      if (endpoint.endsWith('/git/tags/' + 'c'.repeat(40))) return { object: { type: 'commit', sha: SHA_A } };
      if (endpoint.includes('/actions/workflows/ci.yml/runs')) return { total_count: 1, workflow_runs: [run()] };
      if (endpoint.includes('/jobs')) return { total_count: 1, jobs: [gate()] };
      throw new Error(endpoint);
    };
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tagCommitSha, SHA_A);
    assert.equal(calls.filter((url) => url.includes('/git/tags/')).length, 1);
  });

  await check('tag commit different from checked-out SHA is blocked', async () => {
    const fixture = fakeApi({ ref: { object: { type: 'commit', sha: SHA_B } } });
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tag_sha_mismatch');
  });

  await check('no push CI run for the exact SHA is blocked', async () => {
    const fixture = fakeApi({ runs: [] });
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ci_run_missing');
  });

  await check('queued or in-progress push CI is blocked', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const fixture = fakeApi({ runs: [run({ status, conclusion: null })] });
      const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
      assert.equal(result.ok, false, status);
      assert.equal(result.code, 'ci_incomplete', status);
    }
  });

  await check('failed or cancelled push CI is blocked', async () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped']) {
      const fixture = fakeApi({ runs: [run({ conclusion })] });
      const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
      assert.equal(result.ok, false, conclusion);
      assert.equal(result.code, 'ci_failed', conclusion);
    }
  });

  await check('wrong SHA, branch, event, or workflow returned by CI API is blocked', async () => {
    const cases = [
      run({ sha: SHA_B }),
      run({ branch: 'feature' }),
      run({ event: 'pull_request' }),
      run({ path: '.github/workflows/other.yml' }),
    ];
    for (const candidate of cases) {
      const fixture = fakeApi({ runs: [candidate] });
      const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ci_identity_mismatch');
    }
  });

  await check('the newest exact-SHA run wins; an older success cannot hide a newer failure', async () => {
    const fixture = fakeApi({
      runs: [
        run({ id: 202, conclusion: 'failure', createdAt: '2026-10-19T11:00:00Z' }),
        run({ id: 101, conclusion: 'success', createdAt: '2026-10-19T10:00:00Z' }),
      ],
    });
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ci_failed');
    assert.equal(result.run.id, 202);
  });

  await check('missing, incomplete, failed, or duplicate CI gate is blocked', async () => {
    const cases = [
      { jobs: [], code: 'ci_gate_missing' },
      { jobs: [gate({ status: 'in_progress', conclusion: null })], code: 'ci_gate_incomplete' },
      { jobs: [gate({ conclusion: 'failure' })], code: 'ci_gate_failed' },
      { jobs: [gate(), gate({ id: 202 })], code: 'ci_gate_ambiguous' },
    ];
    for (const candidate of cases) {
      const fixture = fakeApi({ jobs: candidate.jobs });
      const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
      assert.equal(result.ok, false, JSON.stringify(candidate));
      assert.equal(result.code, candidate.code);
    }
  });

  await check('API failure blocks release and is not treated as missing or success', async () => {
    const fixture = fakeApi({ fail: { match: '/actions/runs/' } });
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_api_unavailable');
  });

  await check('invalid paged schema fails closed', async () => {
    const cases = [
      async () => ({ workflow_runs: [run()] }),
      async () => ({ total_count: 0, workflow_runs: [run()] }),
      async () => ({ total_count: '1', workflow_runs: [run()] }),
    ];
    for (const firstPage of cases) {
      const api = async (endpoint) => {
        if (endpoint.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: SHA_A } };
        if (endpoint.includes('/actions/workflows/ci.yml/runs')) return firstPage();
        throw new Error(`unexpected fixture endpoint: ${endpoint}`);
      };
      const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, 'github_api_invalid');
    }
  });

  await check('invalid run identity cannot choose a winner or become successful', async () => {
    for (const candidate of [run({ createdAt: 'not-a-time' }), run({ attempt: 0 })]) {
      const fixture = fakeApi({ runs: [candidate] });
      const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ci_run_schema_invalid');
    }
    const fixture = fakeApi({ runs: [run({ id: Number.MAX_SAFE_INTEGER + 1 })] });
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api: fixture.api });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_api_invalid');
  });

  await check('pagination total must remain consistent and account for every item', async () => {
    const api = async (endpoint) => {
      if (endpoint.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: SHA_A } };
      if (endpoint.includes('/actions/workflows/ci.yml/runs') && !endpoint.includes('page=')) {
        return {
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, (_, index) => run({
            id: 1000 + index,
            createdAt: new Date(Date.UTC(2026, 9, 19, 10, 0, index)).toISOString(),
          })),
        };
      }
      if (endpoint.includes('/actions/workflows/ci.yml/runs')) {
        return { total_count: 100, workflow_runs: [run({ id: 2000 })] };
      }
      throw new Error(`unexpected fixture endpoint: ${endpoint}`);
    };
    const result = await verifyCiProof({ tag: 'v1.2.3', sha: SHA_A, repo: 'HYJ1817/pi-gui', api });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_api_invalid');
  });

  await check('event SHA must match the checkout SHA and tag commit', async () => {
    const fixture = fakeApi();
    const result = await verifyCheckoutCiProof({
      tag: 'v1.2.3',
      checkoutSha: SHA_A,
      expectedEventSha: SHA_B,
      repo: 'HYJ1817/pi-gui',
      api: fixture.api,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'event_sha_mismatch');
    assert.equal(fixture.requests.length, 0);
  });

  await check('GitHub API reader uses bounded authentication headers and never mutates the token', async () => {
    const calls = [];
    const api = createGitHubApi({
      token: 'fixture-token',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ fixture: true }) };
      },
    });
    assert.deepEqual(await api('/fixture'), { fixture: true });
    assert.equal(calls[0].url, 'https://api.github.test/fixture');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
    assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
  });

  await check('missing token blocks CI proof before any network call', async () => {
    assert.throws(() => createGitHubApi({ token: '', fetchImpl: async () => { throw new Error('must not run'); } }), {
      code: 'github_token_missing',
    });
  });

  console.log(`\nrelease-ci-proof: ${passed}/${passed + failed}; failed=${failed}`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
