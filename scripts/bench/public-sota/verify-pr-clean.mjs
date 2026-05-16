#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
let repo = process.env.REPO;
let prNumber;
let requireMerged = false;
let waitSeconds = 0;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--repo') {
    repo = args[++index];
  } else if (arg === '--pr') {
    prNumber = Number(args[++index]);
  } else if (arg === '--require-merged') {
    requireMerged = true;
  } else if (arg === '--wait-seconds') {
    waitSeconds = Number(args[++index]);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

if (!Number.isInteger(prNumber) || prNumber <= 0) {
  console.error('Usage: verify-pr-clean.mjs --pr <number> [--repo owner/name] [--require-merged] [--wait-seconds n]');
  process.exit(2);
}
if (!repo) {
  throw new Error('Set --repo owner/name or REPO=owner/name');
}
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
  throw new Error(`Invalid --wait-seconds value: ${waitSeconds}`);
}

const [owner, name] = repo.split('/');
if (!owner || !name) {
  throw new Error(`Invalid repo: ${repo}`);
}

const query = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number
      url
      state
      isDraft
      baseRefName
      headRefOid
      mergeCommit{oid}
      reviewDecision
      commits(last:1){
        nodes{
          commit{
            oid
            statusCheckRollup{
              state
              contexts(first:100){
                nodes{
                  __typename
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const reviewThreadsQuery = `
query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100, after:$after){
        pageInfo{hasNextPage endCursor}
        nodes{isResolved}
      }
    }
  }
}`;

function fetchPr() {
  const raw = execFileSync('gh', [
    'api',
    'graphql',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `number=${prNumber}`,
    '-f', `query=${query}`,
  ], { encoding: 'utf8' });
  const payload = JSON.parse(raw);
  const pr = payload.data?.repository?.pullRequest;
  if (!pr) {
    throw new Error(`PR #${prNumber} not found in ${repo}`);
  }
  return {
    ...pr,
    reviewThreads: {
      nodes: fetchReviewThreads(),
    },
  };
}

function fetchReviewThreads() {
  const threads = [];
  let after;
  for (;;) {
    const command = [
      'api',
      'graphql',
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${prNumber}`,
      '-f', `query=${reviewThreadsQuery}`,
    ];
    if (after) {
      command.push('-f', `after=${after}`);
    }
    const raw = execFileSync('gh', command, { encoding: 'utf8' });
    const payload = JSON.parse(raw);
    const page = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!page) {
      throw new Error(`Could not fetch review threads for PR #${prNumber} in ${repo}`);
    }
    threads.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) {
      return threads;
    }
    after = page.pageInfo.endCursor;
  }
}

function evaluate(pr) {
  const latestCommit = pr.commits?.nodes?.[0]?.commit;
  const checkRollup = latestCommit?.statusCheckRollup;
  const contexts = checkRollup?.contexts?.nodes ?? [];
  const unresolvedThreads = (pr.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved).length;
  const failedContexts = contexts.filter((context) => {
    if (context.__typename === 'CheckRun') {
      return context.status !== 'COMPLETED'
        || !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(context.conclusion);
    }
    if (context.__typename === 'StatusContext') {
      return context.state !== 'SUCCESS';
    }
    return true;
  });

  const failures = [];
  if (pr.isDraft) {
    failures.push('PR is draft');
  }
  if (requireMerged && pr.state !== 'MERGED') {
    failures.push(`PR state is ${pr.state}, expected MERGED`);
  }
  if (!requireMerged && pr.state !== 'OPEN' && pr.state !== 'MERGED') {
    failures.push(`PR state is ${pr.state}, expected OPEN or MERGED`);
  }
  if (unresolvedThreads > 0) {
    failures.push(`${unresolvedThreads} unresolved review thread(s)`);
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    failures.push('PR has changes requested');
  }
  if (!checkRollup) {
    failures.push('missing status check rollup');
  } else if (checkRollup.state !== 'SUCCESS') {
    failures.push(`status check rollup is ${checkRollup.state}`);
  }
  if (failedContexts.length > 0) {
    failures.push(`${failedContexts.length} failed/pending status context(s)`);
  }

  return {
    ok: failures.length === 0,
    repo,
    number: pr.number,
    url: pr.url,
    state: pr.state,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    mergeCommitOid: pr.mergeCommit?.oid ?? null,
    latestCommitOid: latestCommit?.oid ?? null,
    reviewDecision: pr.reviewDecision,
    unresolvedThreads,
    statusCheckRollup: checkRollup?.state ?? null,
    contextCount: contexts.length,
    failedContexts: failedContexts.map((context) => ({
      type: context.__typename,
      name: context.name ?? context.context,
      status: context.status ?? context.state,
      conclusion: context.conclusion ?? null,
      url: context.detailsUrl ?? context.targetUrl ?? null,
    })),
    failures,
  };
}

const deadline = Date.now() + (waitSeconds * 1000);
let result = evaluate(fetchPr());
while (!result.ok && Date.now() < deadline) {
  const waitable = result.failures.every((failure) => (
    failure === 'missing status check rollup'
    || failure.startsWith('status check rollup is ')
    || failure.endsWith('failed/pending status context(s)')
  ));
  if (!waitable) {
    break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  result = evaluate(fetchPr());
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exit(1);
}
