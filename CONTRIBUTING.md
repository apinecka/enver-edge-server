# Contributing

Issues and pull requests are welcome. For a security issue, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## How changes land

The agent is developed together with the rest of Enver in a private repository, and this repository receives a snapshot of it with every release. A pull request is therefore not merged here directly: once it is accepted, the change is applied to the private repository with you as its author, and it comes back here with the next release, which then closes the pull request.

Keep a pull request to one change, with tests (`npm test`) and a clean `npm run lint`. The agent talks to Enver through `libs/edge-protocol`; a change to that protocol also needs a change on the Enver side, so open an issue first.

## Developer Certificate of Origin

Every commit must be signed off (`git commit -s`), which certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or otherwise have the right to submit it under the project's license (Apache License 2.0).
