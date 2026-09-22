# Requirement coverage — MCP governance

Every governance requirement (IDs defined in [`TEST_ARCHITECTURE.md`](../TEST_ARCHITECTURE.md) §2,
derived from `docs/poc/requirements-aug28.md` and `docs/code-mode-governance.md`) mapped to the
executable tests that prove it. "E2E" = `tests/e2e/governance/*.test.ts` (real MCP calls over
HTTP against the production image); "Unit/Int" = the pre-existing vitest layers; "Postman" =
folders of `postman/mcp-governance.postman_collection.json`; "CI" = the workflow that runs it.
Status reflects the last full run (`npm run test:governance`).

| Requirement | Expected behaviour | Existing unit / integration test | E2E test (file › test) | Postman folder | CI | Status |
|---|---|---|---|---|---|---|
| RG-001 durable `executionId` in `_meta` | one program ⇒ one id across every round trip | `execution-manager.test.ts`, `execute-api.tool.codemode.test.ts` | protocol › should_stamp_server_info_and_execution_metadata…; lifecycle › should_keep_one_execution_id_across_every_round_trip… | 03, 06, 08 | governance-e2e | PASS |
| RG-002 original code authoritative | resume ignores replacement code | `execute-api.tool.codemode.test.ts` (fallback path) | replay › should_run_the_persisted_program_and_ignore_replacement_code…; replay › should_also_ignore_replacement_code_on_the_meta_resume_path; bypass › should_not_let_a_resume_change_the_resource_or_the_action… | 07 (resume with replacement code) | governance-e2e | PASS |
| RG-003 lifecycle states | CREATED/RUNNING/WAITING_APPROVAL/INTERRUPTED/COMPLETED/FAILED/DENIED/CANCELLED observable | `execution-manager.test.ts`, `execution-types.test.ts` | lifecycle › should_expose_every_lifecycle_state…; failures › should_interrupt_with_sandbox_timeout…; lifecycle › …dies_while_a_post_is_in_flight (RUNNING after crash) | 03–09 | governance-e2e | PASS |
| RG-004 activity journal | sequence in arrival order; request (no headers) + response persisted | `code-mode-replay.test.ts` | replay › should_persist_query_body_and_path_params_but_never_headers…; allow › should_execute_downstream_exactly_once… (record shape) | 03, 10 | governance-e2e | PASS |
| RG-005 replay without re-execution | completed GET and POST never re-issued; stored response returned | `code-mode-replay.test.ts`, `code-mode-acceptance.test.ts` | replay › should_replay_completed_get_and_post_activities…; replay › should_replay_a_recorded_non_2xx_response_as_is; replay › should_not_re_execute_a_completed_execution… | 08, 10 | governance-e2e | PASS |
| RG-006 multiple approval rounds | two pauses, two approvals, one program | `code-mode-acceptance.test.ts` | multi-step › should_pause_at_step_2_then_step_3_and_complete_after_both_approvals… | 08 | governance-e2e | PASS |
| RG-007 governance before side effect; V8 cannot bypass | DENY ⇒ 0 downstream; every call crosses the bridge | `code-mode-replay.test.ts` (verdicts), `sandbox.test.ts` | deny › (all); bypass › should_expose_no_network_or_host_globals…; bypass › should_still_govern_a_call_made_through_the_raw_bridge_reference; bypass › should_refuse_every_later_call_once_a_denial_stopped_the_run… | 04, 13 | governance-e2e | PASS |
| RG-008 OpenAPI-aware targeting | operationId / path template / path params resolved | `operation-resolver.test.ts` | allow › should_execute_downstream_exactly_once… (operationId, pathParams); allow › should_allow_ops_reads_via_a_method_plus_wildcard_path_rule; deny › …rule_denies_delete (method + template) | 03 | governance-e2e | PASS |
| RG-009 request-value conditions | body / path values decide | `governance-rules.test.ts` | allow › should_treat_the_threshold_amount_itself_as_not_high_value; approval › …when_a_high_value_order_is_created; deny › should_deny_a_restricted_resource…; deny › …allow_rule_and_a_deny_rule_both_match | 04, 05 | governance-e2e | PASS |
| RG-010 declarative, deterministic, no LLM | same input ⇒ same decision, rule files only | `governance-rules.test.ts` | audit › should_stamp_the_same_rule_hash_on_every_execution…; (no model dependency in the image — enforced by the mock-only network: `--network none` in boot test) | 14 | governance-e2e | PASS |
| RG-011 precedence + default | DENY > REQUIRE_APPROVAL > ALLOW; default when nothing matches | `governance-rules.test.ts` | deny › should_let_deny_win…; deny › should_let_require_approval_win…; allow › should_allow_by_the_configured_default…; defaults › should_deny_an_operation_no_rule_matches_when_the_default_decision_is_deny | 03, 04 | governance-e2e | PASS |
| RG-012 decision persistence + rule versions | decision, reason, matched rules, `name@version#hash12`, deciding rule, time | `governance-rules.test.ts`, `execution-store.test.ts` | audit › should_record_every_decision_with_rule_identity…; audit › should_stamp_the_same_rule_hash…; allow/deny (decision assertions) | 03, 04, 14 | governance-e2e | PASS |
| RG-013 approval over MCP elicitation (MRTR) | `input_required` + `elicitation/create` form + `requestState`; accept/decline/cancel mapped | `execute-api.tool.codemode.test.ts`, `mcp-approval-wire.test.ts`, `approval-service.test.ts` | approval › should_pause_with_an_elicitation_form…; …when_the_human_accepts; …when_the_human_declines; should_treat_accept_with_approve_false_as_a_rejection; …when_the_human_cancels; should_ask_again… | 05, 06, 09 | governance-e2e | PASS |
| RG-014 approval bound to one activity | ids match one activity; later activity needs a new approval | `approval-service.test.ts` | approval › should_bind_the_approval_to_the_specific_activity…; multi-step › …a_new_approval (ap2 ≠ ap1); multi-step › should_deny_step_3_by_rule_after_step_2_was_approved… | 05, 08 | governance-e2e | PASS |
| RG-015 fresh isolate on resume | program restarts from the top; `runCount`/`runIndex`; no re-issued calls | `code-mode-acceptance.test.ts` | lifecycle › should_run_each_resume_in_a_fresh_isolate…; lifecycle › should_refuse_every_later_call_in_a_paused_isolate…; multi-step › (startedAt ≥ decidedAt) | 06, 08 | governance-e2e | PASS |
| RG-016 bridge owns governance; sandbox untrusted | no network/host globals; raw bridge still governed | `sandbox.test.ts` | bypass › should_expose_no_network_or_host_globals…; bypass › should_still_govern_a_call_made_through_the_raw_bridge_reference | 13 | governance-e2e | PASS |
| RG-017 replay divergence | different call at a journaled sequence ⇒ `REPLAY_DIVERGED`, nothing executed | `code-mode-replay.test.ts` | replay › should_stop_with_replay_diverged… | — (needs a clock wait) | governance-e2e | PASS |
| RG-018 execution locking | concurrent resumes ⇒ one runs, other `EXECUTION_LOCKED` | `execution-manager.test.ts` | idempotency › should_let_only_one_of_two_simultaneous_approval_answers…; …simultaneous_meta_resumes_run | — (needs concurrency) | governance-e2e | PASS |
| RG-019 failure handling | explicit status ⇒ COMPLETED/replayable; transport ⇒ FAILED/unknown/never repeated; crash mid-call fails closed (GET re-executes) | `code-mode-replay.test.ts` | failures › (all); replay › should_fail_closed_with_outcome_unknown…; lifecycle › …dies_while_a_post_is_in_flight; lifecycle › should_re_execute_a_safe_get… | 12 | governance-e2e | PASS |
| RG-020 inspection + history | `GET /executions/{id}` with activities/approvals/decisions/history | `execution-routes.test.ts` | audit › should_derive_a_chronological_history…; audit › should_answer_404…; multi-step (history events) | 03–14 (inspect requests) | governance-e2e | PASS |
| RG-021 namespaced `_meta` | `harbor/*` keys only; serverInfo reserved | `tool-helpers.test.ts` | protocol › should_stamp_server_info_and_execution_metadata…; bypass › should_not_be_fooled_by_spoofed…server_info | 03 | governance-e2e | PASS |
| RG-022 stateless transport | no session id issued/required; independent requests | `http-gateway.test.ts` | protocol › should_issue_no_session_id_and_ignore_a_client_supplied_one; protocol › should_reject_get_on_the_mcp_endpoint… | 02 | governance-e2e | PASS |
| RG-023 durability across restart | paused execution + approval + requestState survive a process restart (file store) | `execution-store.test.ts` (file store) | lifecycle › should_survive_a_gateway_restart_while_paused… | — (needs container control) | governance-e2e | PASS |
| RG-024 bearer auth + principal binding | 401 on every entry point; resume/answer bound to the creating principal | `bearer-*.test.ts`, `execute-api.tool.codemode.test.ts` | authentication › (all); authorization › …different_principal…; authorization › should_refuse_a_meta_resume_of_another_principals_execution | 13 | governance-e2e | PASS |
| RG-025 requestState integrity | tampered / expired / foreign / wrong-method state refused | `request-state.test.ts`, `mcp-approval-wire.test.ts` | authorization › should_refuse_a_tampered_request_state…; defaults › should_refuse_an_expired_request_state…; defaults › should_reject_a_request_state_minted_by_the_other_instance; authorization › should_not_honour_a_request_state_on_a_method_it_was_not_minted_for | 13 | governance-e2e | PASS |
| RG-026 fail closed | invalid rule file stops boot; evaluation error denies; default honoured | `governance-rules.test.ts` | boot › should_refuse_to_start_when_a_governance_rule_file_is_invalid; defaults › (default DENY) | — | governance-e2e | PASS |
| RG-027 HTTP fallback approval | `APPROVAL_REQUIRED` + ids; decide over HTTP; resume by id | `execution-routes.test.ts`, `execute-api.tool.codemode.test.ts` | approval › client without elicitation › (all 5) | 07 | governance-e2e | PASS |
| RG-028 approval decided once | duplicate MRTR answer / HTTP decision / resume ⇒ no second side effect; stale states refused | `approval-service.test.ts`, `execution-routes.test.ts` | idempotency › (all); authorization › should_refuse_a_stale_request_state…; …after_the_execution_completed; …through_a_different_executions_path | 06, 07, 11, 13 | governance-e2e | PASS |
| RG-029 §47 acceptance end to end | two approval rounds; every call exactly once, in order, across three isolates | `code-mode-acceptance.test.ts` | multi-step › should_pause_at_step_2_then_step_3_and_complete_after_both_approvals_with_every_call_exactly_once | 08 | governance-e2e | PASS |
| RG-030 MCP 2026-07-28 correctness | headers/envelope matrix, legacy rejected, malformed rejected, five frozen tools, arg validation | `mcp-server-factory.test.ts`, `mcp-request-identity.test.ts`, `http-gateway.test.ts` | protocol › (all 24) | 02, 12 | governance-e2e | PASS |

## Scenario checklist from the harness specification

| Scenario | Test |
|---|---|
| Multi-step A: approve, approve | multi-step › …complete_after_both_approvals… |
| Multi-step B: deny first | multi-step › should_terminate_at_step_2_and_never_reach_step_3… |
| Multi-step C: approve, deny second | multi-step › should_stop_at_step_3_and_never_execute_step_4… |
| Deny after approval (step 3 DENY by rule) | multi-step › should_deny_step_3_by_rule_after_step_2_was_approved… |
| Approval timeout (D) | defaults › should_refuse_an_expired_request_state… (requestState TTL — the only expiry the implementation has) |
| Duplicate approval (E) | idempotency › should_not_execute_twice…; should_refuse_a_second_http_decision_with_409… |
| Approval for wrong execution (F) | authorization › …through_a_different_executions_path; …tampered_request_state; …different_principal |
| Approval for wrong step / stale (G) | authorization › should_refuse_a_stale_request_state_from_an_earlier_activity… |
| Isolate cleanup + recreation | lifecycle › should_run_each_resume_in_a_fresh_isolate…; multi-step (startedAt); lifecycle › should_refuse_every_later_call_in_a_paused_isolate… |
| Persistence + restart | lifecycle › should_survive_a_gateway_restart_while_paused… |
| Crash mid-call | lifecycle › …dies_while_a_post_is_in_flight; …re_execute_a_safe_get… |
| Replay after pause / completed / failure | replay › (all) |
| Concurrency | idempotency › …simultaneous_approval_answers; …simultaneous_meta_resumes; multi-step › …two_concurrent_workflows_of_different_principals_independent |
| Policy matrix (per operation and value) | allow, deny, approval, defaults (see `tests/e2e/fixtures/governance/default/README.md`) |
| Malformed MCP | protocol › (matrix + argument validation) |
| Unauthenticated / weak credentials | authentication › (table) |
| Bypass attempts | bypass › (all) |
| Boot refusal on invalid policy | boot › should_refuse_to_start_when_a_governance_rule_file_is_invalid |
| Empty / one-step / failing-at-step-N workflows | lifecycle › should_complete_an_empty_program…; allow › (one step); failures › should_keep_the_completed_first_step_when_a_middle_step_fails |

## Known gaps (not testable on this branch, or pinned as current behaviour)

| Gap | Where it is visible | Note |
|---|---|---|
| Role- / user-based rules (readonly-user cannot WRITE, per-user resource access) | — | Rules see no principal attributes on this branch (`GovernanceRequest`); the policy matrix is per operation + request value. Principal-aware rules exist on `poc/sept01-governance`. |
| Any valid bearer can inspect / decide another principal's execution over HTTP | authorization › known_gap_any_valid_bearer_can_inspect_and_decide… | Documented POC limitation (docs/code-mode-governance.md §14). The *resume* stays principal-bound. |
| A program can override the outbound `Authorization` header | bypass › known_gap_program_supplied_headers_can_override_the_outbound_authorization_header | `runtime/api-client/api-client.ts` spreads `apiRequest.headers` after the auth header. Rules are unaffected (they do not read identity here); backend authorization is. **Recommend fixing in production code** (not done: the harness must not silently change gateway behaviour). |
| Uncaught backend timeout reported as `SANDBOX_TIMEOUT` | failures › known_quirk_an_uncaught_backend_timeout_is_reported_as_sandbox_timeout | `sandbox-core.ts normalizeIsolateError` classifies any error message containing "timeout". Journal is correct (FAILED, outcome unknown); only the tool-level code/message is misleading. |
| Policy versioning across a pause; rule reload | — | Rules load at boot only. Decisions carry `ruleVersions` tags (tested). |
| Cancelling a running execution; approval expiry in the store | — | No API; only the `cancel` answer and the requestState TTL exist. |
| Sessions | protocol › (stateless) | 2026-07-28 has none; tested as absence. |
| stdio transport | — | Unit-tested only (`stdio-gateway.test.ts`). |
| Body-level replay divergence | — | Not detected by design (D§14). |
| Multi-instance locking | — | Lock is process-local; concurrency tests run against one instance. |
