export const EXAMPLE_CICD = `title: Ship a malicious release through CI/CD

# Facts are true statements about the system. "reality" is the implicit root.
facts:
- public_repo: Source code is public on GitHub
  from:
  - reality
- self_hosted_runners: Self-hosted runners hold cloud credentials
  from:
  - reality: '#yolosec'

attacks:
- phish_maintainer: Phish a maintainer's password
  from:
  - public_repo
- steal_session: Steal a session cookie with an infostealer
  from:
  - hardware_keys
- push_to_main: Push straight to main
  from:
  - phish_maintainer
  - steal_session
- forge_approval: Approve own PR with a second account
  from:
  - branch_protection
- malicious_pr: Open a PR with a poisoned workflow
  from:
  - public_repo
  - require_codeowners:
    backwards: true
- pwn_request: Workflow runs fork code with secrets
  from:
  - malicious_pr: '#yolosec'
- dump_runner_creds: Dump credentials from the runner
  from:
  - pwn_request
  - self_hosted_runners
- tamper_artifact: Tamper with the artifact after build
  from:
  - dump_runner_creds
- poison_dependency: Typosquat a build dependency
  from:
  - public_repo
- forge_signature: Sign with a leaked signing key
  from:
  - signed_releases

mitigations:
- hardware_keys: Phishing-resistant MFA (FIDO2)
  from:
  - phish_maintainer
- branch_protection: Branch protection with required review
  from:
  - push_to_main
- require_codeowners: CODEOWNERS on workflow files
  from:
  - forge_approval
- no_fork_secrets: No secrets for fork PRs
  from:
  - pwn_request:
    implemented: false
- ephemeral_runners: Ephemeral, isolated runners
  from:
  - dump_runner_creds
- lockfile_pinning: Lockfiles with hash pinning
  from:
  - poison_dependency
- signed_releases: Signed releases with provenance
  from:
  - tamper_artifact
- keyless_signing: Keyless signing (OIDC + transparency log)
  from:
  - forge_signature

goals:
- malicious_release: Malicious release reaches users
  from:
  - push_to_main
  - forge_approval
  - tamper_artifact
  - poison_dependency
  - forge_signature
- cloud_takeover: Take over the production cloud account
  from:
  - dump_runner_creds
`;

export const BLANK_TREE = `title: Untitled tree

attacks:
- first_attack: What would an attacker try first?
  from:
  - reality

goals:
- attacker_wins: What the attacker ultimately wants
  from:
  - first_attack
`;
