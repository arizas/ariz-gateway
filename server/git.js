import cgi from 'cgi';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Restrict a URL path segment (account id / repo name) to a safe directory name,
// so it can never traverse out of the per-account git root.
function safeSegment(seg) {
    const cleaned = String(seg).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
    return cleaned || '_';
}

/**
 * Git smart-HTTP handler. Serves one bare repo per authenticated account under
 * `<dataDir>/git/<account>/<repo>.git` via `git http-backend`. The account comes
 * from the auth middleware (`req.accountId`), so a caller only ever reaches their
 * own repos; the repo name comes from the URL. Bare repos are created lazily on
 * first access (push-enabled), so a client can clone an empty repo and push to it.
 *
 * Mount behind auth:  app.use('/git', auth, createGitHandler({ dataDir }))
 * Client remote URL:  <gateway>/git/<repo>   (the account is implied by the token)
 */
export function createGitHandler({ dataDir }) {
    const gitRoot = join(dataDir, 'git');

    return function gitHandler(req, res) {
        const account = req.accountId;
        if (!account) { res.statusCode = 401; res.end('unauthorized'); return; }

        // After the /git mount, req.url is /<repo>[.git]/<service>[?query], e.g.
        // /nearsight/info/refs?service=git-upload-pack  or  /nearsight/git-receive-pack
        const url = req.url || '/';
        const firstSlash = url.indexOf('/', 1);
        const firstSeg = (firstSlash === -1 ? url.slice(1) : url.slice(1, firstSlash)).split('?')[0];
        const rest = firstSlash === -1 ? '' : url.slice(firstSlash);
        const repoName = safeSegment(firstSeg.replace(/\.git$/, ''));
        if (firstSeg === '') { res.statusCode = 404; res.end('repo not specified'); return; }

        const accountDir = join(gitRoot, safeSegment(account));
        const repoDir = `${repoName}.git`;
        const repoPath = join(accountDir, repoDir);
        if (!existsSync(repoPath)) {
            mkdirSync(accountDir, { recursive: true });
            execFileSync('git', ['init', '--bare', '--initial-branch=master', repoPath]);
            // Allow authenticated push over HTTP to this repo.
            execFileSync('git', ['-C', repoPath, 'config', 'http.receivepack', 'true']);
        }

        // http-backend resolves GIT_PROJECT_ROOT + PATH_INFO, so PATH_INFO must
        // name the on-disk dir (<repo>.git) regardless of how the client spelled it.
        req.url = `/${repoDir}${rest}`;
        const handler = cgi('git', {
            args: ['http-backend'],
            stderr: process.stderr,
            env: {
                GIT_PROJECT_ROOT: accountDir,
                GIT_HTTP_EXPORT_ALL: '1',
                REMOTE_USER: account, // marks the request authenticated (enables receive-pack)
            },
        });
        handler(req, res);
    };
}
