import json
import time
from typing import Any, Dict

from archive_store import (
    build_archive_payload,
    build_board_from_history,
    infer_result_type,
    infer_status,
    load_archive,
    new_game_id,
    normalize_move_history,
    normalize_participants,
    write_archive,
)


def _response(status_code: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'statusCode': status_code,
        'headers': {
            'content-type': 'application/json',
            'cache-control': 'no-cache',
        },
        'body': json.dumps(payload),
    }


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get('body') or '{}'
    if isinstance(body, str):
        return json.loads(body)
    if isinstance(body, dict):
        return body
    return {}


def _handle_get(event: Dict[str, Any]) -> Dict[str, Any]:
    game_id = str(event.get('pathParameters', {}).get('gameId') or '').strip()
    if not game_id:
        return _response(400, {'ok': False, 'message': 'missing gameId'})

    payload = load_archive(game_id)
    if payload is None:
        return _response(404, {'ok': False, 'message': 'game not found'})

    return _response(200, payload)


def _handle_post(event: Dict[str, Any]) -> Dict[str, Any]:
    body = _parse_body(event)
    move_history = normalize_move_history(body.get('moveHistory', []))
    participants = normalize_participants(body.get('participants'))
    winner = str(body.get('winner') or '').upper()
    winner = winner if winner in ('X', 'O') else None
    now = int(time.time())
    status = infer_status(move_history, winner, body.get('status'))
    result_type = infer_result_type(status, winner, body.get('resultType'))

    game = {
        'gameId': new_game_id(),
        'roomId': body.get('roomId'),
        'status': status,
        'createdAt': now,
        'updatedAt': now,
        'startedAt': body.get('startedAt') or now,
        'endedAt': body.get('endedAt'),
        'visibility': body.get('visibility') or 'public',
        'gameMode': body.get('gameMode') or 'snapshot',
        'participants': participants,
        'winner': winner,
        'resultType': result_type,
        'moveHistory': move_history,
        'finalBoard': build_board_from_history(move_history),
    }
    game['archiveKey'] = f"games/{game['gameId']}.json"
    key = write_archive(game)
    payload = build_archive_payload(game)
    return _response(
        201,
        {
            'ok': True,
            'gameId': payload['gameId'],
            'archiveKey': key,
            'path': f"/games/{payload['gameId']}",
            'game': payload,
        },
    )


def handler(event, _context):
    method = event.get('requestContext', {}).get('http', {}).get('method')
    route_key = event.get('routeKey')

    if method == 'GET' or route_key == 'GET /games/{gameId}':
        return _handle_get(event)

    if method == 'POST' or route_key == 'POST /games':
        return _handle_post(event)

    return _response(405, {'ok': False, 'message': 'method not allowed'})
