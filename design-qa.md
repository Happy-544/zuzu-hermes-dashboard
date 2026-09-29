# Design QA

- Reference: user-provided desktop screenshots for the Models settings page.
- Verified: hierarchy, two-column desktop layout, responsive single-column mobile layout, conversation brain, voice engine, routing mode, fallback chain, project override, provider cards, secret-key status, and full-width Apply action.
- Interaction: project provider/model selection updates correctly and can return to global inheritance.
- Accessibility: controls retain explicit labels and native keyboard-operable inputs.
- Secret handling: existing keys are represented only as `key set` / `no key`; values are never returned to the browser.

final result: passed
