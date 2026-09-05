# API

Production endpoint:

`POST https://evuvgxruavnadpbiehgb.supabase.co/functions/v1/command`

Headers:

- `Authorization: Bearer <user access token>`
- `apikey: <publishable or anon key>`
- `Content-Type: application/json`

Body:

```json
{
  "command_id": "<uuid>",
  "type": "create_tournament",
  "payload": { "name": "Open" }
}
```

The server loads the actor from JWT `sub`. Client-supplied user ids, roles, and match statuses are not trusted for authorization.

Local Node API: `packages/api` (`POST /command`) using `SUPABASE_SERVICE_ROLE_KEY` on the server only.

## Commands

| type | who |
| --- | --- |
| create_tournament | any authenticated user (becomes organizer of the new tournament) |
| update_tournament, transition_tournament | organizer/admin |
| create_division, update_division | organizer/admin |
| add_person, create_team, add_team_member, remove_team_member, register_participant | organizer/admin |
| create_court, add_member | organizer/admin |
| generate_bracket, generate_team_elimination, generate_team_playoffs | organizer/admin |
| assign_court, assign_umpire, transition_match | organizer/admin |
| start_match, coin_toss, score_event, complete_match | assigned umpire or organizer/admin |

Duplicate `command_id` returns the stored result (`idempotent: true`). Duplicate score `event_id` returns current reduced state without applying twice.
