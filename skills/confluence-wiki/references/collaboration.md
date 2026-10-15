## Comments

Use footer comments by default; pass `--kind inline` for every inline operation.
Replace example IDs and expected versions with fresh reads. Prepare new Markdown
body files for creation/replies; `comment.md` below is a downloaded edit file.

```sh
cfwiki comments list 12345
cfwiki comments list 12345 --kind inline --json
cfwiki comments read 67890 -o comment.md
cfwiki comments replies 67890
cfwiki comments create 12345 draft-comment.md
cfwiki comments reply 67890 reply.md
cfwiki comments update 67890 comment.md --version 1
cfwiki comments delete 67890 --version 2 --yes
cfwiki comments create 12345 inline.md --kind inline --selection 'exact page text' --selection-count 1 --selection-index 0
cfwiki comments read 78901 --kind inline
cfwiki comments replies 78901 --kind inline
cfwiki comments reply 78901 reply.md --kind inline
cfwiki comments resolve 78901 --kind inline --resolved true --version 1
cfwiki comments resolve 78901 --kind inline --resolved false --version 2
```

Only mutate comments when the user's request authorizes that action. Read output
uses `confluence_comment` metadata, never page `confluence.id`; preserve its site/API
binding, identity, kind, and version when editing. Explicit targets must match the
metadata. Never reuse another comment's metadata to create a new root or reply.
`--json` gives structured output; individual `read --body-only` omits metadata.
Use `-o`/`--output` and `--overwrite` as for page reads. Create/reply/update accept
`-` for stdin; successful file writes update comment metadata, while stdin results
go to stdout. Comments do not apply page templates, upload attachments, or save
page properties.

Inline root creation requires exact selection text, a positive occurrence count,
and a zero-based index below that count. Inspect the page; never guess an anchor.
Replies target the parent comment ID (`parentCommentId` in Cloud), not a page ID.
Resolve/reopen retains the body. Update/delete/resolve require the current
`--version`; stale input must be re-read and merged, never manually version-bumped.
Deletion uses a preflight version check, not an atomic server version condition.
Never automatically retry an ambiguously completed comment creation.

Cloud supports footer/inline reads, CRUD, replies, and inline resolve/reopen.
Data Center supports footer root CRUD and footer/inline list/read. Its page list
preserves reply identity when returned, but `replies` traversal, `reply` creation,
and all inline writes are unsupported and fail before mutation with
`Data Center <operation> is not supported by this CLI.` Do not invent REST calls
to bypass that boundary. 401/403/404 are failures, not empty successful results.


## Page restrictions and protected creation

New upload/push pages use explicit `--restrictions`, then the selected profile's
`CONFLUENCE_RESTRICTIONS`, then `view-edit`. Example profiles set
`CONFLUENCE_RESTRICTIONS=view-edit`. Ordinary existing uploads/pushes preserve ACLs;
profile defaults and downloaded YAML never authorize ACL changes. Explicit
creation restriction flags on a single existing upload fail with
`Use restrictions set to change existing page restrictions.` Mixed bundles apply
these flags only to new pages.

```sh
cfwiki upload new-page.md --space DOCS --restrictions view-edit
cfwiki push wiki --space DOCS --restrictions view-edit
cfwiki restrictions get 12345 --json
cfwiki restrictions set 12345 --restrictions view-edit --read-user account-id-1 --read-group group-id-1 --edit-user account-id-2 --edit-group group-id-2
cfwiki restrictions set 12345 --restrictions edit --edit-user account-id-2
cfwiki restrictions set 12345 --restrictions none
```

`restrictions set` replaces the entire direct ACL; include every intended subject.
Allowlist flags are repeatable and also work on upload/push. Cloud uses account
IDs/group IDs; Data Center uses usernames/group names, never guessed display names
or emails. Allowlists require an explicit mode: `edit` rejects read allowlists;
`none` rejects all allowlists. Restricted operations retain creator and actor;
`view-edit` additionally grants direct read access to allowed editors.
`edit` restricts editing only; viewing still follows space and ancestor access.
`none` clears direct restrictions, not inherited or space restrictions, and does
not promise public access. `get` reports direct ACLs, not effective access.
Replacement is read back and verified but has no compare-and-swap guarantee.

Cloud restricted creation starts with `private=true`. Data Center creates a
harmless UUID-titled empty shell, sets and verifies protection, then publishes
real title/body. The shell's existence may briefly be visible; this is not atomic
DC create+ACL. Attachments, labels, and properties follow verified protection.
Never fall back to public creation after protection fails. Preserve returned
ID/version and pending-create state on partial failure. Recovery checks the bound
site, page identity, and protection before continuing the saved file; do not erase
identity or pending state to force another POST. For stdin, retain the safe
ID/version/stage and recovery instructions in the error. If no create response
arrived, inspect remote state before any retry; success or rollback is unknown.

Cloud comment reads use `read:comment:confluence`; writes/resolution use
`write:comment:confluence`; deletion uses `delete:comment:confluence`. Updates and
deletes also need read access for version preflight. Direct restriction reads,
readback, and current-user discovery require `read:content-details:confluence`;
replacement/removal adds `write:content.restriction:confluence`. Cloud creator
lookup reads page `authorId` with `read:page:confluence`; DC reads content history
for the creator. See README's endpoint references and full profile requirements.

Cloud Free cannot enforce page restrictions. The current Free test site returned
404 for private creation. Do not remove private defaults to bypass that failure
or attribute every 401/403/404 to missing scopes. Local HTTP fixtures verify
request/error logic only. Cloud footer CRUD/replies and inline creation/resolution/
reopening/deletion were verified on the live test site. Paid Cloud restriction
success and real Data Center compatibility remain unverified.


## Delete

Only when the user's request authorizes deletion:

```sh
cfwiki delete wiki/guide.md --version 3 --yes --env /path/to/profile.env
# Or use a just-read ID and expected version:
cfwiki delete 12345 --version 3 --yes --env /path/to/profile.env
```

Delete moves a current page to trash, without purging. It checks the current version
immediately before deleting; the server delete API is not an atomic versioned write.
Do not delete unrelated pages or use delete to resolve a version conflict.

See the repository README for Cloud scope requirements, Data Center bearer PAT
configuration, conversion limits, and troubleshooting. Report corporate-server
compatibility as unverified until the user's actual instance has been tested.
