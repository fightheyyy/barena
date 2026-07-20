# Security Policy

## Supported versions

Barena is a pre-1.0 project. Security fixes are currently applied to the `main` branch. Older commits and unpublished snapshots are not maintained as separate supported release lines.

## Reporting a vulnerability

Please do not disclose exploitable details in a public issue, discussion, or pull request.

Use GitHub's private vulnerability reporting flow for this repository: open the **Security** tab, choose **Advisories**, and select **Report a vulnerability**. Include:

- the affected version or commit;
- the operating system and Node.js version;
- the smallest reproducible example;
- the expected and observed security boundary;
- the potential impact and any known mitigations.

If private vulnerability reporting is unavailable, open a public issue that asks the maintainers to establish a private contact channel, but do not include vulnerability details in that issue. This repository does not publish a dedicated security email address or guarantee a response timeline.

## Relevant boundaries

Useful reports include command or argument injection, unsafe writes outside an intended workspace, path traversal, evidence tampering, credential disclosure, and trust-boundary mistakes in target or verifier protocols.

Barena intentionally launches configured external agent runtimes and drivers. Portable tool policy is not an operating-system sandbox, and boundary evidence does not reveal hidden model reasoning or native tool sequencing. A report should distinguish a documented limitation from behavior that crosses the documented boundary.
