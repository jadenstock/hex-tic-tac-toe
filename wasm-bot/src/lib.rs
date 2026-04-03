use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

const WIN_LENGTH: i32 = 6;
const MAX_THREAT_INDEX: usize = WIN_LENGTH as usize;
const CANDIDATE_RADIUS_FALLBACK: i32 = 2;
const MIN_SCORED_CANDIDATE_POINTS: i32 = 3;
const SINGLE_THREAT_MAX_DISTANCE: i32 = 2;
const FORCING_SOLVER_DEPTH: u8 = 8;
const FORCING_DEFENDER_BRANCH_CAP: usize = 15;
const FORCING_PROVEN_WIN_SCORE: f64 = 2.0;
const FORCING_PROVEN_LOSS_SCORE: f64 = -2.0;
const FORCING_STATUS_SCORE_BOUNDARY: f64 = 1.5;
const DIRECTIONS: [(i32, i32); 3] = [(1, 0), (0, 1), (1, -1)];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
enum Player {
    X,
    O,
}

impl Player {
    fn opponent(self) -> Self {
        match self {
            Self::X => Self::O,
            Self::O => Self::X,
        }
    }
}

type Coord = (i32, i32);

type BoardMap = HashMap<Coord, Player>;

type ThreatGroupMap = HashMap<String, usize>;

#[derive(Clone, Debug)]
struct BoardState {
    moves: BoardMap,
    move_history: Vec<PlacedMove>,
    turn: Player,
    placements_left: u8,
}

#[derive(Clone, Copy, Debug)]
struct PlacedMove {
    q: i32,
    r: i32,
}

#[derive(Clone, Debug)]
struct ActiveWindow {
    direction_index: usize,
    cells: [Coord; WIN_LENGTH as usize],
    x_count: usize,
    o_count: usize,
}

#[derive(Clone, Debug)]
struct BoardFeatures {
    active_windows: Vec<ActiveWindow>,
    x_one_turn_groups: ThreatGroupMap,
    o_one_turn_groups: ThreatGroupMap,
}

#[derive(Clone, Debug)]
struct EvalSummary {
    x_score: f64,
    o_score: f64,
    x_one_turn_wins: usize,
    o_one_turn_wins: usize,
}

#[derive(Clone, Debug)]
struct RankedPlacement {
    option: Coord,
    immediate_win: bool,
    objective: f64,
    own_score: f64,
    opp_one_turn_wins: usize,
}

#[derive(Clone, Debug)]
struct RankedLine {
    line: Vec<Coord>,
    objective: f64,
    own_score: f64,
    immediate_win: bool,
    opp_one_turn_wins: usize,
}

#[derive(Clone, Debug)]
struct ResidualRankedLine {
    line: Vec<Coord>,
    objective: f64,
    own_score: f64,
    immediate_win: bool,
    initial_rank: usize,
    residual_objective: f64,
}

#[derive(Clone, Copy, Debug)]
struct CandidatePolicy {
    top_cell_count: usize,
    max_line_count: usize,
}

#[derive(Clone, Debug)]
struct EngineParams {
    threat_weights: [f64; 7],
    defense_weight: f64,
    tempo_discount_per_stone: f64,
    threat_severity_scale: f64,
    candidate_radius: i32,
    top_k_first_moves: usize,
    turn_candidate_count: usize,
    child_turn_candidate_count: usize,
    exploration_c: f64,
    max_simulation_turns: usize,
    simulation_turn_candidate_count: usize,
    simulation_radius: i32,
    simulation_top_k_first_moves: usize,
}

#[derive(Default, Debug)]
struct EngineStats {
    nodes_expanded: u32,
    board_evaluations: u32,
}

#[derive(Debug, Deserialize)]
struct MoveCell {
    q: i32,
    r: i32,
    mark: String,
}

#[derive(Debug, Deserialize, Default)]
struct SearchOptionsInput {
    exploration_c: Option<f64>,
    turn_candidate_count: Option<usize>,
    child_turn_candidate_count: Option<usize>,
    max_simulation_turns: Option<usize>,
    simulation_turn_candidate_count: Option<usize>,
    simulation_radius: Option<i32>,
    simulation_top_k_first_moves: Option<usize>,
}

#[derive(Debug, Deserialize, Default)]
struct BotTuningInput {
    threat_weights: Option<Vec<f64>>,
    defense_weight: Option<f64>,
    tempo_discount_per_stone: Option<f64>,
    threat_severity_scale: Option<f64>,
    candidate_radius: Option<i32>,
    top_k_first_moves: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ChooseTurnRequest {
    turn: String,
    placements_left: u8,
    max_time_ms: Option<u32>,
    max_nodes: Option<u32>,
    moves: Vec<MoveCell>,
    #[serde(default)]
    tuning: BotTuningInput,
    #[serde(default)]
    search_options: SearchOptionsInput,
}

#[derive(Debug, Serialize)]
struct MoveChoice {
    q: i32,
    r: i32,
}

#[derive(Debug, Serialize)]
struct ChooseTurnResponse {
    moves: Vec<MoveChoice>,
    mode: &'static str,
    stop_reason: &'static str,
    nodes_expanded: u32,
    playouts: u32,
    board_evaluations: u32,
    root_candidates: u32,
    max_depth_turns: u32,
    forcing_status: &'static str,
    forcing_nodes: u32,
    forcing_cache_hits: u32,
    forcing_cache_misses: u32,
    forcing_elapsed_ms: u32,
    forcing_root_candidates: u32,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Clone, Debug)]
struct ThreatWindow {
    threat: usize,
    direction_index: usize,
    cut_set: Vec<Coord>,
}

#[derive(Clone, Debug)]
struct ThreatLevelStats {
    blocker_burden: usize,
    resilience: f64,
    direction_count: usize,
    pressure: f64,
}

#[derive(Clone, Debug)]
struct ThreatProfile {
    levels: Vec<ThreatLevelStats>,
    total_pressure: f64,
}

#[derive(Clone, Debug)]
struct MctsNode {
    parent: Option<usize>,
    action_from_parent: Vec<Coord>,
    player_to_move: Player,
    depth_turns: u32,
    children: Vec<usize>,
    unexpanded_actions: Option<Vec<Vec<Coord>>>,
    visits: u32,
    total_value: f64,
    terminal_winner: Option<Player>,
}

#[derive(Clone, Copy, Debug)]
struct ForcingProofBudget {
    deadline_ms: f64,
    max_nodes: u32,
    nodes_visited: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ForcingStatus {
    Win,
    Loss,
    Unknown,
}

impl ForcingStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Win => "win",
            Self::Loss => "loss",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ForcingCacheEntry {
    status: ForcingStatus,
    score: f64,
}

#[derive(Clone, Debug)]
struct ForcingLineScore {
    line: Vec<Coord>,
    score: f64,
}

#[derive(Clone, Debug)]
struct ForcingNodeResult {
    status: ForcingStatus,
    score: f64,
    best_action: Option<Vec<Coord>>,
}

#[derive(Clone, Debug)]
struct ForcingSolveResult {
    status: ForcingStatus,
    best_action: Option<Vec<Coord>>,
    root_line_scores: Vec<ForcingLineScore>,
}

#[derive(Clone, Debug)]
struct ForcingSearchContext {
    budget: ForcingProofBudget,
    cache: HashMap<String, ForcingCacheEntry>,
    cache_hits: u32,
    cache_misses: u32,
    start_depth: u8,
    max_depth_turns: u32,
    root_candidates: usize,
    root_line_scores: Vec<ForcingLineScore>,
}

#[derive(Clone, Debug)]
struct ForcingTelemetry {
    attempted: bool,
    status: ForcingStatus,
    nodes: u32,
    cache_hits: u32,
    cache_misses: u32,
    elapsed_ms: u32,
    root_candidates: usize,
    max_depth_turns: u32,
}

impl Default for ForcingTelemetry {
    fn default() -> Self {
        Self {
            attempted: false,
            status: ForcingStatus::Unknown,
            nodes: 0,
            cache_hits: 0,
            cache_misses: 0,
            elapsed_ms: 0,
            root_candidates: 0,
            max_depth_turns: 0,
        }
    }
}

fn to_error_json(message: impl Into<String>) -> String {
    serde_json::to_string(&ErrorResponse {
        error: message.into(),
    })
    .unwrap_or_else(|_| "{\"error\":\"serialization error\"}".to_owned())
}

fn parse_player(raw: &str) -> Option<Player> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "X" => Some(Player::X),
        "O" => Some(Player::O),
        _ => None,
    }
}

fn to_key(coord: Coord) -> String {
    format!("{},{}", coord.0, coord.1)
}

fn parse_coord_key(key: &str) -> Option<Coord> {
    let mut parts = key.split(',');
    let q = parts.next()?.parse::<i32>().ok()?;
    let r = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((q, r))
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

fn turn_state_from_move_count(total_moves: usize) -> (Player, u8) {
    if total_moves == 0 {
        return (Player::X, 1);
    }
    if total_moves == 1 {
        return (Player::O, 2);
    }
    let k = total_moves - 1;
    let turn_index = k / 2;
    let turn = if turn_index % 2 == 0 { Player::O } else { Player::X };
    let placements_left = if k % 2 == 0 { 2 } else { 1 };
    (turn, placements_left)
}

fn normalize_params(request: &ChooseTurnRequest) -> EngineParams {
    let mut threat_weights = [0.0_f64, 0.0, 6.0, 36.0, 860.0, 860.0, 20000.0];

    if let Some(weights) = &request.tuning.threat_weights {
        for (idx, slot) in threat_weights.iter_mut().enumerate() {
            if let Some(value) = weights.get(idx) {
                *slot = *value;
            }
        }
    }

    let candidate_radius = request
        .tuning
        .candidate_radius
        .unwrap_or(4)
        .max(1)
        .min(8);

    let top_k_first_moves = request
        .tuning
        .top_k_first_moves
        .unwrap_or(12)
        .max(1)
        .min(48);

    let turn_candidate_count = request
        .search_options
        .turn_candidate_count
        .unwrap_or(8)
        .max(1)
        .min(64);

    let child_turn_candidate_count = request
        .search_options
        .child_turn_candidate_count
        .unwrap_or(8)
        .max(1)
        .min(64);

    let exploration_c = request
        .search_options
        .exploration_c
        .unwrap_or(1.15)
        .max(0.0);

    let max_simulation_turns = request
        .search_options
        .max_simulation_turns
        .unwrap_or(3)
        .max(1)
        .min(12);

    let simulation_turn_candidate_count = request
        .search_options
        .simulation_turn_candidate_count
        .unwrap_or(4)
        .max(1)
        .min(24);

    let simulation_radius = request
        .search_options
        .simulation_radius
        .unwrap_or(3)
        .max(1)
        .min(8);

    let simulation_top_k_first_moves = request
        .search_options
        .simulation_top_k_first_moves
        .unwrap_or(2)
        .max(1)
        .min(12);

    EngineParams {
        threat_weights,
        defense_weight: request.tuning.defense_weight.unwrap_or(1.1).max(0.0),
        tempo_discount_per_stone: request.tuning.tempo_discount_per_stone.unwrap_or(0.08).max(0.0),
        threat_severity_scale: request.tuning.threat_severity_scale.unwrap_or(3000.0).max(1.0),
        candidate_radius,
        top_k_first_moves,
        turn_candidate_count,
        child_turn_candidate_count,
        exploration_c,
        max_simulation_turns,
        simulation_turn_candidate_count,
        simulation_radius,
        simulation_top_k_first_moves,
    }
}

fn count_direction(board: &BoardMap, q: i32, r: i32, dq: i32, dr: i32, player: Player) -> i32 {
    let mut count = 0;
    let mut cq = q + dq;
    let mut cr = r + dr;
    while board.get(&(cq, cr)).copied() == Some(player) {
        count += 1;
        cq += dq;
        cr += dr;
    }
    count
}

fn is_winning_placement(board: &BoardMap, q: i32, r: i32, player: Player) -> bool {
    for (dq, dr) in DIRECTIONS {
        let forward = count_direction(board, q, r, dq, dr, player);
        let backward = count_direction(board, q, r, -dq, -dr, player);
        if 1 + forward + backward >= WIN_LENGTH {
            return true;
        }
    }
    false
}

fn find_winner(board: &BoardMap) -> Option<Player> {
    for (&(q, r), &player) in board {
        if is_winning_placement(board, q, r, player) {
            return Some(player);
        }
    }
    None
}

fn apply_move_mut(board: &mut BoardState, coord: Coord, mark: Player) -> Result<Option<Player>, String> {
    if board.placements_left == 0 {
        return Err("no placements left".to_owned());
    }
    if board.moves.contains_key(&coord) {
        return Err("occupied cell".to_owned());
    }

    board.moves.insert(coord, mark);
    board.move_history.push(PlacedMove {
        q: coord.0,
        r: coord.1,
    });

    if is_winning_placement(&board.moves, coord.0, coord.1, mark) {
        board.placements_left = 0;
        return Ok(Some(mark));
    }

    board.placements_left = board.placements_left.saturating_sub(1);
    if board.placements_left == 0 {
        let (next_turn, next_placements) = turn_state_from_move_count(board.moves.len());
        board.turn = next_turn;
        board.placements_left = next_placements;
    }

    Ok(None)
}

fn apply_move_copy(board: &BoardState, coord: Coord, mark: Player) -> Option<(BoardState, Option<Player>)> {
    let mut next = board.clone();
    apply_move_mut(&mut next, coord, mark).ok().map(|winner| (next, winner))
}

fn apply_turn_line(board: &BoardState, line: &[Coord], player: Player) -> (BoardState, Vec<Coord>, Option<Player>) {
    let mut next = board.clone();
    let mut applied = Vec::new();
    let mut winner = None;

    for &coord in line {
        if next.placements_left == 0 || winner.is_some() {
            break;
        }
        match apply_move_mut(&mut next, coord, player) {
            Ok(result) => {
                applied.push(coord);
                if result.is_some() {
                    winner = result;
                }
            }
            Err(_) => {
                continue;
            }
        }
    }

    (next, applied, winner)
}

fn sorted_unique_coords(cells: Vec<Coord>) -> Vec<Coord> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for coord in cells {
        if seen.insert(coord) {
            unique.push(coord);
        }
    }
    unique.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    unique
}

fn canonical_line_key(line: &[Coord]) -> String {
    let mut normalized = line.to_vec();
    normalized.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    normalized
        .iter()
        .map(|coord| to_key(*coord))
        .collect::<Vec<_>>()
        .join("|")
}

fn threat_group_key(empties: &[Coord]) -> Option<String> {
    if empties.is_empty() {
        return None;
    }
    let mut sorted = empties.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    if sorted.len() == 1 {
        return Some(to_key(sorted[0]));
    }
    Some(format!("{}|{}", to_key(sorted[0]), to_key(sorted[1])))
}

fn collect_active_windows(board: &BoardMap) -> Vec<ActiveWindow> {
    if board.is_empty() {
        return Vec::new();
    }

    let mut window_keys = HashSet::new();
    for (&(q, r), _) in board {
        for (direction_index, (dq, dr)) in DIRECTIONS.iter().enumerate() {
            for offset in 0..WIN_LENGTH {
                let start_q = q - dq * offset;
                let start_r = r - dr * offset;
                window_keys.insert((start_q, start_r, direction_index));
            }
        }
    }

    let mut windows = Vec::new();

    for (start_q, start_r, direction_index) in window_keys {
        let (dq, dr) = DIRECTIONS[direction_index];
        let mut cells = [(0, 0); WIN_LENGTH as usize];
        let mut x_count = 0;
        let mut o_count = 0;

        for idx in 0..WIN_LENGTH {
            let q = start_q + dq * idx;
            let r = start_r + dr * idx;
            let coord = (q, r);
            cells[idx as usize] = coord;
            match board.get(&coord).copied() {
                Some(Player::X) => x_count += 1,
                Some(Player::O) => o_count += 1,
                None => {}
            }
        }

        if x_count == 0 && o_count == 0 {
            continue;
        }

        windows.push(ActiveWindow {
            direction_index,
            cells,
            x_count,
            o_count,
        });
    }

    windows
}

fn window_empties(board: &BoardMap, window: &ActiveWindow) -> Vec<Coord> {
    window
        .cells
        .iter()
        .copied()
        .filter(|coord| !board.contains_key(coord))
        .collect()
}

fn collect_features(board: &BoardMap) -> BoardFeatures {
    let active_windows = collect_active_windows(board);
    let mut x_one_turn_groups: ThreatGroupMap = HashMap::new();
    let mut o_one_turn_groups: ThreatGroupMap = HashMap::new();

    for window in &active_windows {
        if window.x_count > 0 && window.o_count == 0 {
            let empty_count = WIN_LENGTH as usize - window.x_count;
            if window.x_count >= 4 && empty_count <= 2 {
                if let Some(key) = threat_group_key(&window_empties(board, window)) {
                    *x_one_turn_groups.entry(key).or_insert(0) += 1;
                }
            }
        }

        if window.o_count > 0 && window.x_count == 0 {
            let empty_count = WIN_LENGTH as usize - window.o_count;
            if window.o_count >= 4 && empty_count <= 2 {
                if let Some(key) = threat_group_key(&window_empties(board, window)) {
                    *o_one_turn_groups.entry(key).or_insert(0) += 1;
                }
            }
        }
    }

    BoardFeatures {
        active_windows,
        x_one_turn_groups,
        o_one_turn_groups,
    }
}

fn one_turn_groups(features: &BoardFeatures, player: Player) -> &ThreatGroupMap {
    match player {
        Player::X => &features.x_one_turn_groups,
        Player::O => &features.o_one_turn_groups,
    }
}

fn collect_one_turn_finish_cells(features: &BoardFeatures, player: Player) -> HashSet<Coord> {
    let mut finish = HashSet::new();

    for key in one_turn_groups(features, player).keys() {
        if let Some((first, second)) = key.split_once('|') {
            if let Some(coord) = parse_coord_key(first) {
                finish.insert(coord);
            }
            if let Some(coord) = parse_coord_key(second) {
                finish.insert(coord);
            }
        } else if let Some(coord) = parse_coord_key(key) {
            finish.insert(coord);
        }
    }

    finish
}

fn threat_group_pairs(features: &BoardFeatures, player: Player) -> Vec<(Coord, Option<Coord>)> {
    let mut pairs = Vec::new();
    let groups = one_turn_groups(features, player);

    for key in groups.keys() {
        if let Some((first_raw, second_raw)) = key.split_once('|') {
            let Some(first) = parse_coord_key(first_raw) else {
                continue;
            };
            let Some(second) = parse_coord_key(second_raw) else {
                continue;
            };
            pairs.push((first, Some(second)));
            continue;
        }

        if let Some(first) = parse_coord_key(key) {
            pairs.push((first, None));
        }
    }

    pairs
}

fn pair_covered_by_cells(pair: &(Coord, Option<Coord>), first: Coord, second: Option<Coord>) -> bool {
    if pair.0 == first || second == Some(pair.0) {
        return true;
    }
    if let Some(other) = pair.1 {
        return other == first || second == Some(other);
    }
    false
}

fn minimum_blockers_required_from_pairs(pairs: &[(Coord, Option<Coord>)]) -> usize {
    if pairs.is_empty() {
        return 0;
    }

    let mut unique_cells = Vec::new();
    let mut seen = HashSet::new();
    for (first, second) in pairs {
        if seen.insert(*first) {
            unique_cells.push(*first);
        }
        if let Some(cell) = second {
            if seen.insert(*cell) {
                unique_cells.push(*cell);
            }
        }
    }

    for &cell in &unique_cells {
        if pairs
            .iter()
            .all(|pair| pair_covered_by_cells(pair, cell, None))
        {
            return 1;
        }
    }

    for first_idx in 0..unique_cells.len() {
        for second_idx in (first_idx + 1)..unique_cells.len() {
            let first = unique_cells[first_idx];
            let second = unique_cells[second_idx];
            if pairs
                .iter()
                .all(|pair| pair_covered_by_cells(pair, first, Some(second)))
            {
                return 2;
            }
        }
    }

    3
}

fn one_turn_blockers_required(features: &BoardFeatures, player: Player) -> usize {
    let pairs = threat_group_pairs(features, player);
    minimum_blockers_required_from_pairs(&pairs)
}

fn has_immediate_threats(features: &BoardFeatures) -> bool {
    !features.x_one_turn_groups.is_empty() || !features.o_one_turn_groups.is_empty()
}

fn enumerate_covering_move_sets(
    pairs: &[(Coord, Option<Coord>)],
    placements_available: usize,
) -> Vec<Vec<Coord>> {
    if pairs.is_empty() || placements_available == 0 {
        return Vec::new();
    }

    let mut unique_cells = Vec::new();
    let mut seen = HashSet::new();
    for (first, second) in pairs {
        if seen.insert(*first) {
            unique_cells.push(*first);
        }
        if let Some(cell) = second {
            if seen.insert(*cell) {
                unique_cells.push(*cell);
            }
        }
    }

    let mut sets = Vec::new();

    for &cell in &unique_cells {
        if pairs
            .iter()
            .all(|pair| pair_covered_by_cells(pair, cell, None))
        {
            sets.push(vec![cell]);
        }
    }

    if placements_available >= 2 {
        for first_idx in 0..unique_cells.len() {
            for second_idx in (first_idx + 1)..unique_cells.len() {
                let first = unique_cells[first_idx];
                let second = unique_cells[second_idx];
                if pairs
                    .iter()
                    .all(|pair| pair_covered_by_cells(pair, first, Some(second)))
                {
                    sets.push(vec![first, second]);
                }
            }
        }
    }

    sets
}

fn exact_blocking_responses(board: &BoardState, attacker: Player) -> Vec<Vec<Coord>> {
    if board.placements_left == 0 {
        return Vec::new();
    }

    let features = collect_features(&board.moves);
    let pairs = threat_group_pairs(&features, attacker);
    let raw_sets = enumerate_covering_move_sets(&pairs, board.placements_left as usize);
    if raw_sets.is_empty() {
        return Vec::new();
    }

    let mut deduped = HashSet::new();
    let mut lines = Vec::new();

    for mut line in raw_sets {
        line.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let key = canonical_line_key(&line);
        if key.is_empty() || !deduped.insert(key) {
            continue;
        }
        lines.push(line);
    }

    lines
}

fn threat_count_exponent(threat: usize) -> f64 {
    if threat >= 4 {
        3.0
    } else if threat == 3 {
        2.0
    } else {
        1.5
    }
}

fn count_stones(board: &BoardMap, player: Player) -> usize {
    board.values().filter(|&&mark| mark == player).count()
}

fn apply_tempo_discount(score: f64, own_stones: usize, opp_stones: usize, k: f64) -> f64 {
    if score <= 0.0 {
        return 0.0;
    }
    let delta = own_stones.saturating_sub(opp_stones) as f64;
    if delta <= 0.0 {
        return score;
    }
    score / (1.0 + k.max(0.0) * delta)
}

fn extended_run_length(board: &BoardMap, player: Player, cells: &[Coord], direction_index: usize) -> usize {
    let (dq, dr) = DIRECTIONS[direction_index];
    let occupied: Vec<bool> = cells
        .iter()
        .map(|coord| board.get(coord).copied() == Some(player))
        .collect();

    let mut best = 0_usize;
    let mut idx = 0_usize;

    while idx < occupied.len() {
        if !occupied[idx] {
            idx += 1;
            continue;
        }

        let run_start = idx;
        while idx + 1 < occupied.len() && occupied[idx + 1] {
            idx += 1;
        }
        let run_end = idx;

        let mut length = run_end - run_start + 1;
        let mut prev_q = cells[run_start].0 - dq;
        let mut prev_r = cells[run_start].1 - dr;
        while board.get(&(prev_q, prev_r)).copied() == Some(player) {
            length += 1;
            prev_q -= dq;
            prev_r -= dr;
        }

        let mut next_q = cells[run_end].0 + dq;
        let mut next_r = cells[run_end].1 + dr;
        while board.get(&(next_q, next_r)).copied() == Some(player) {
            length += 1;
            next_q += dq;
            next_r += dr;
        }

        best = best.max(length);
        idx += 1;
    }

    best
}

fn collect_threat_windows(board: &BoardMap, features: &BoardFeatures, player: Player) -> Vec<ThreatWindow> {
    let mut windows = Vec::new();

    for window in &features.active_windows {
        let (own_count, opp_count) = match player {
            Player::X => (window.x_count, window.o_count),
            Player::O => (window.o_count, window.x_count),
        };

        if own_count == 0 || opp_count > 0 {
            continue;
        }

        let threat = extended_run_length(board, player, &window.cells, window.direction_index);
        if threat < 2 || threat >= WIN_LENGTH as usize {
            continue;
        }

        let cut_set = window_empties(board, window);
        if cut_set.is_empty() {
            continue;
        }

        windows.push(ThreatWindow {
            threat,
            direction_index: window.direction_index,
            cut_set,
        });
    }

    windows
}

fn greedy_blocker_burden(cut_sets: &[Vec<Coord>], max_blockers: usize) -> usize {
    if cut_sets.is_empty() {
        return 0;
    }

    let mut remaining: Vec<Vec<Coord>> = cut_sets.to_vec();
    let mut blockers = 0_usize;

    while !remaining.is_empty() && blockers < max_blockers {
        let mut coverage: HashMap<Coord, usize> = HashMap::new();
        for cells in &remaining {
            for &cell in cells {
                *coverage.entry(cell).or_insert(0) += 1;
            }
        }

        let mut best_cell = None;
        let mut best_coverage = 0_usize;
        for (cell, count) in coverage {
            if count > best_coverage {
                best_cell = Some(cell);
                best_coverage = count;
            }
        }

        if best_coverage == 0 {
            break;
        }

        let chosen = match best_cell {
            Some(cell) => cell,
            None => break,
        };

        blockers += 1;
        remaining = remaining
            .into_iter()
            .filter(|cells| !cells.contains(&chosen))
            .collect();
    }

    if remaining.is_empty() {
        blockers
    } else {
        max_blockers + 1
    }
}

fn residual_window_ratio_after_best_block(cut_sets: &[Vec<Coord>]) -> f64 {
    if cut_sets.is_empty() {
        return 0.0;
    }

    let mut coverage: HashMap<Coord, usize> = HashMap::new();
    for cells in cut_sets {
        for &cell in cells {
            *coverage.entry(cell).or_insert(0) += 1;
        }
    }

    let mut best_cell = None;
    let mut best_coverage = 0_usize;
    for (cell, count) in coverage {
        if count > best_coverage {
            best_cell = Some(cell);
            best_coverage = count;
        }
    }

    let chosen = match best_cell {
        Some(cell) => cell,
        None => return 0.0,
    };

    let remaining = cut_sets
        .iter()
        .filter(|cells| !cells.contains(&chosen))
        .count();

    remaining as f64 / cut_sets.len() as f64
}

fn pressure_for_threat_level(
    windows: &[ThreatWindow],
    threat: usize,
    params: &EngineParams,
) -> ThreatLevelStats {
    let level_windows: Vec<&ThreatWindow> = windows.iter().filter(|window| window.threat == threat).collect();
    if level_windows.is_empty() {
        return ThreatLevelStats {
            blocker_burden: 0,
            resilience: 0.0,
            direction_count: 0,
            pressure: 0.0,
        };
    }

    let cut_sets: Vec<Vec<Coord>> = level_windows
        .iter()
        .map(|window| window.cut_set.clone())
        .collect();

    let window_count = level_windows.len();
    let blocker_burden = greedy_blocker_burden(&cut_sets, 4);
    let resilience = residual_window_ratio_after_best_block(&cut_sets);
    let direction_count = level_windows
        .iter()
        .map(|window| window.direction_index)
        .collect::<HashSet<_>>()
        .len();

    let weight = params.threat_weights.get(threat).copied().unwrap_or(0.0);
    let count_pressure = (window_count as f64).powf(threat_count_exponent(threat));
    let pressure = weight
        * count_pressure
        * (blocker_burden.max(1) as f64)
        * (0.5 + 0.5 * resilience);

    ThreatLevelStats {
        blocker_burden,
        resilience,
        direction_count,
        pressure,
    }
}

fn collect_threat_profile(board: &BoardMap, features: &BoardFeatures, player: Player, params: &EngineParams) -> ThreatProfile {
    let windows = collect_threat_windows(board, features, player);
    let mut levels = Vec::with_capacity(MAX_THREAT_INDEX + 1);
    for threat in 0..=MAX_THREAT_INDEX {
        levels.push(pressure_for_threat_level(&windows, threat, params));
    }

    let mut total_pressure = 0.0;
    for threat in 2..=5 {
        total_pressure += levels[threat].pressure;
    }

    ThreatProfile {
        levels,
        total_pressure,
    }
}

fn evaluate_board_summary(board: &BoardState, params: &EngineParams, stats: &mut EngineStats) -> EvalSummary {
    stats.board_evaluations = stats.board_evaluations.saturating_add(1);

    let features = collect_features(&board.moves);
    let x_one_turn_wins = features.x_one_turn_groups.len();
    let o_one_turn_wins = features.o_one_turn_groups.len();

    let x_stones = count_stones(&board.moves, Player::X);
    let o_stones = count_stones(&board.moves, Player::O);

    let x_profile = collect_threat_profile(&board.moves, &features, Player::X, params);
    let o_profile = collect_threat_profile(&board.moves, &features, Player::O, params);

    let scale = params.threat_severity_scale.max(1.0);
    let x_raw = apply_tempo_discount(
        x_profile.total_pressure,
        x_stones,
        o_stones,
        params.tempo_discount_per_stone,
    );
    let o_raw = apply_tempo_discount(
        o_profile.total_pressure,
        o_stones,
        x_stones,
        params.tempo_discount_per_stone,
    );

    let x_score = x_raw / (x_raw + scale);
    let o_score = o_raw / (o_raw + scale);

    let _use_fields = (
        x_profile.levels[3].direction_count,
        o_profile.levels[3].direction_count,
        x_profile.levels[3].blocker_burden,
        o_profile.levels[3].blocker_burden,
        x_profile.levels[3].resilience,
        o_profile.levels[3].resilience,
    );

    EvalSummary {
        x_score,
        o_score,
        x_one_turn_wins,
        o_one_turn_wins,
    }
}

fn objective_for_player(result: &EvalSummary, player: Player, params: &EngineParams) -> f64 {
    let (own, opp) = match player {
        Player::X => (result.x_score, result.o_score),
        Player::O => (result.o_score, result.x_score),
    };
    own - params.defense_weight * opp
}

fn score_for_player(result: &EvalSummary, player: Player) -> f64 {
    match player {
        Player::X => result.x_score,
        Player::O => result.o_score,
    }
}

fn opponent_one_turn_wins(result: &EvalSummary, player: Player) -> usize {
    match player {
        Player::X => result.o_one_turn_wins,
        Player::O => result.x_one_turn_wins,
    }
}

fn hex_distance(a: Coord, b: Coord) -> i32 {
    let dq = a.0 - b.0;
    let dr = a.1 - b.1;
    let ds = -dq - dr;
    dq.abs().max(dr.abs()).max(ds.abs())
}

fn can_belong_to_player_winning_six(board: &BoardMap, coord: Coord, player: Player) -> bool {
    if board.get(&coord).copied() == Some(player.opponent()) {
        return false;
    }

    for (dq, dr) in DIRECTIONS {
        for offset in -(WIN_LENGTH - 1)..=0 {
            let mut blocked = false;
            for idx in 0..WIN_LENGTH {
                let cell = (coord.0 + dq * (offset + idx), coord.1 + dr * (offset + idx));
                if board.get(&cell).copied() == Some(player.opponent()) {
                    blocked = true;
                    break;
                }
            }
            if !blocked {
                return true;
            }
        }
    }

    false
}

fn is_dead_candidate_hex(board: &BoardMap, coord: Coord) -> bool {
    !can_belong_to_player_winning_six(board, coord, Player::X)
        && !can_belong_to_player_winning_six(board, coord, Player::O)
}

fn candidate_cells(board: &BoardState, radius: i32) -> Vec<Coord> {
    if board.move_history.is_empty() {
        return vec![(0, 0)];
    }

    let mut candidates = HashSet::new();
    for mv in &board.move_history {
        for dq in -radius..=radius {
            for dr in -radius..=radius {
                let ds = -dq - dr;
                let distance = dq.abs().max(dr.abs()).max(ds.abs());
                if distance > radius {
                    continue;
                }

                let coord = (mv.q + dq, mv.r + dr);
                if board.moves.contains_key(&coord) {
                    continue;
                }
                candidates.insert(coord);
            }
        }
    }

    let mut out: Vec<Coord> = candidates.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    out
}

fn collect_threat_connected_candidates(features: &BoardFeatures, board: &BoardMap, player: Player) -> Vec<Coord> {
    let mut candidates = HashSet::new();

    for window in &features.active_windows {
        let (own, opp) = match player {
            Player::X => (window.x_count, window.o_count),
            Player::O => (window.o_count, window.x_count),
        };

        if own == 0 || opp > 0 {
            continue;
        }

        for coord in window_empties(board, window) {
            candidates.insert(coord);
        }
    }

    let mut out: Vec<Coord> = candidates.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    out
}

fn collect_defensive_response_candidate_keys(features: &BoardFeatures, board: &BoardMap, player: Player) -> HashSet<Coord> {
    let mut keys = HashSet::new();
    let opponent = player.opponent();

    for window in &features.active_windows {
        let (opp_own, opp_blocked) = match opponent {
            Player::X => (window.x_count, window.o_count),
            Player::O => (window.o_count, window.x_count),
        };

        if opp_blocked > 0 || opp_own == 0 {
            continue;
        }

        for coord in window_empties(board, window) {
            keys.insert(coord);
        }
    }

    keys
}

fn nearest_occupied_distance_in_window(board: &BoardMap, window: &ActiveWindow, player: Player, cell: Coord) -> i32 {
    let mut best = i32::MAX;
    for &window_cell in &window.cells {
        if board.get(&window_cell).copied() == Some(player) {
            best = best.min(hex_distance(cell, window_cell));
        }
    }
    best
}

fn collect_scored_candidate_entries(board: &BoardMap, features: &BoardFeatures) -> Vec<(Coord, i32)> {
    let mut scores: HashMap<Coord, i32> = HashMap::new();

    for window in &features.active_windows {
        let owner = if window.x_count > 0 && window.o_count == 0 {
            Some(Player::X)
        } else if window.o_count > 0 && window.x_count == 0 {
            Some(Player::O)
        } else {
            None
        };

        let player = match owner {
            Some(value) => value,
            None => continue,
        };

        let threat = match player {
            Player::X => window.x_count,
            Player::O => window.o_count,
        };
        if threat == 0 {
            continue;
        }

        let points = if threat >= 2 { 2 } else { 1 };

        for empty in window_empties(board, window) {
            if threat == 1 {
                let distance = nearest_occupied_distance_in_window(board, window, player, empty);
                if distance > SINGLE_THREAT_MAX_DISTANCE {
                    continue;
                }
            }
            if is_dead_candidate_hex(board, empty) {
                continue;
            }
            *scores.entry(empty).or_insert(0) += points;
        }
    }

    let mut out: Vec<(Coord, i32)> = scores.into_iter().collect();
    out.sort_by(|(a_coord, a_score), (b_coord, b_score)| {
        b_score
            .cmp(a_score)
            .then_with(|| a_coord.0.cmp(&b_coord.0))
            .then_with(|| a_coord.1.cmp(&b_coord.1))
    });
    out
}

fn collect_live_neighbor_candidates(board: &BoardState) -> Vec<Coord> {
    let mut neighbors = Vec::new();
    let mut seen = HashSet::new();

    for mv in &board.move_history {
        let move_coord = (mv.q, mv.r);
        if is_dead_candidate_hex(&board.moves, move_coord) {
            continue;
        }

        for (dq, dr) in DIRECTIONS {
            let forward = (mv.q + dq, mv.r + dr);
            let backward = (mv.q - dq, mv.r - dr);

            for coord in [forward, backward] {
                if board.moves.contains_key(&coord)
                    || seen.contains(&coord)
                    || is_dead_candidate_hex(&board.moves, coord)
                {
                    continue;
                }
                seen.insert(coord);
                neighbors.push(coord);
            }
        }
    }

    neighbors.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    neighbors
}

fn collect_legal_candidates(board: &BoardState, player: Player, params: &EngineParams, target_count: usize) -> Vec<Coord> {
    let features = collect_features(&board.moves);

    let own_finishes = collect_one_turn_finish_cells(&features, player);
    if !own_finishes.is_empty() {
        let mut out: Vec<Coord> = own_finishes.into_iter().collect();
        out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        return out;
    }

    let forced_blocks = collect_one_turn_finish_cells(&features, player.opponent());
    if !forced_blocks.is_empty() {
        let mut out: Vec<Coord> = forced_blocks.into_iter().collect();
        out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        return out;
    }

    let scored = collect_scored_candidate_entries(&board.moves, &features);
    let thresholded: Vec<(Coord, i32)> = scored
        .iter()
        .copied()
        .filter(|(_, score)| *score >= MIN_SCORED_CANDIDATE_POINTS)
        .collect();

    let fallback_thresholded: Vec<(Coord, i32)> = if !thresholded.is_empty() {
        thresholded
    } else {
        scored
            .iter()
            .copied()
            .filter(|(_, score)| *score >= 2)
            .collect()
    };

    let selected = if !fallback_thresholded.is_empty() {
        fallback_thresholded
    } else {
        scored.clone()
    };

    let live_neighbors = collect_live_neighbor_candidates(board);

    if !selected.is_empty() || !live_neighbors.is_empty() {
        let cap = if target_count > 0 {
            (target_count.saturating_mul(3)).max(target_count.saturating_add(6))
        } else {
            24
        };

        let mut pool = live_neighbors;
        pool.extend(selected.into_iter().take(cap).map(|(coord, _)| coord));
        return sorted_unique_coords(pool);
    }

    let connected = collect_threat_connected_candidates(&features, &board.moves, player);
    let defensive = collect_defensive_response_candidate_keys(&features, &board.moves, player);

    let mut primary = collect_live_neighbor_candidates(board);
    primary.extend(
        connected
            .into_iter()
            .filter(|coord| !is_dead_candidate_hex(&board.moves, *coord)),
    );
    primary.extend(
        defensive
            .into_iter()
            .filter(|coord| !is_dead_candidate_hex(&board.moves, *coord)),
    );

    let unique_primary = sorted_unique_coords(primary);
    if !unique_primary.is_empty() {
        return unique_primary;
    }

    candidate_cells(board, CANDIDATE_RADIUS_FALLBACK.min(params.candidate_radius))
        .into_iter()
        .filter(|coord| !is_dead_candidate_hex(&board.moves, *coord))
        .collect()
}

fn rank_placements(
    board: &BoardState,
    player: Player,
    params: &EngineParams,
    move_options: &[Coord],
    stats: &mut EngineStats,
) -> Vec<RankedPlacement> {
    let mut ranked = Vec::new();

    for &option in move_options {
        let (next_board, winner) = match apply_move_copy(board, option, player) {
            Some(value) => value,
            None => continue,
        };

        let immediate_win = winner == Some(player);
        let eval_result = evaluate_board_summary(&next_board, params, stats);
        let objective = if immediate_win {
            f64::INFINITY
        } else {
            objective_for_player(&eval_result, player, params)
        };
        let own_score = score_for_player(&eval_result, player);
        let opp_one_turn_wins = opponent_one_turn_wins(&eval_result, player);

        ranked.push(RankedPlacement {
            option,
            immediate_win,
            objective,
            own_score,
            opp_one_turn_wins,
        });
    }

    ranked.sort_by(|a, b| {
        b.immediate_win
            .cmp(&a.immediate_win)
            .then_with(|| b.objective.total_cmp(&a.objective))
            .then_with(|| b.own_score.total_cmp(&a.own_score))
    });

    ranked
}

fn score_applied_turn(
    board: &BoardState,
    player: Player,
    line: Vec<Coord>,
    winner: Option<Player>,
    params: &EngineParams,
    stats: &mut EngineStats,
) -> RankedLine {
    let eval_result = evaluate_board_summary(board, params, stats);
    RankedLine {
        line,
        objective: if winner == Some(player) {
            f64::INFINITY
        } else {
            objective_for_player(&eval_result, player, params)
        },
        own_score: score_for_player(&eval_result, player),
        immediate_win: winner == Some(player),
        opp_one_turn_wins: opponent_one_turn_wins(&eval_result, player),
    }
}

fn sort_ranked_lines(lines: &mut [RankedLine]) {
    lines.sort_by(|a, b| {
        b.immediate_win
            .cmp(&a.immediate_win)
            .then_with(|| b.objective.total_cmp(&a.objective))
            .then_with(|| b.own_score.total_cmp(&a.own_score))
    });
}

fn prune_defensively_critical_lines(lines: Vec<RankedLine>, baseline_opp_wins: usize) -> Vec<RankedLine> {
    if baseline_opp_wins == 0 {
        return lines;
    }

    let fully_blocked: Vec<RankedLine> = lines
        .iter()
        .cloned()
        .filter(|entry| entry.opp_one_turn_wins == 0)
        .collect();
    if !fully_blocked.is_empty() {
        return fully_blocked;
    }

    let min_opp_wins = lines
        .iter()
        .map(|entry| entry.opp_one_turn_wins)
        .min()
        .unwrap_or(0);

    lines
        .into_iter()
        .filter(|entry| entry.opp_one_turn_wins == min_opp_wins)
        .collect()
}

fn widened_top_cell_count(base_top_k: usize, max_count: usize, max_bonus: usize) -> usize {
    let capped_max = max_count.max(1);
    let base = base_top_k.max(1).min(capped_max);
    let spare = capped_max.saturating_sub(base);
    let bonus = max_bonus.min((spare + 1) / 2);
    (base + bonus).min(capped_max)
}

fn collect_winning_turn_lines(
    board: &BoardState,
    player: Player,
    params: &EngineParams,
) -> Vec<Vec<Coord>> {
    if board.placements_left == 0 {
        return Vec::new();
    }

    let first_options = collect_legal_candidates(board, player, params, 0);
    if first_options.is_empty() {
        return Vec::new();
    }

    let mut winners = Vec::new();
    let mut seen = HashSet::new();

    for first in first_options {
        let (after_first, first_winner) = match apply_move_copy(board, first, player) {
            Some(value) => value,
            None => continue,
        };

        if first_winner == Some(player) {
            let line = vec![first];
            let key = canonical_line_key(&line);
            if seen.insert(key) {
                winners.push(line);
            }
            continue;
        }

        if after_first.placements_left == 0 {
            continue;
        }

        let second_options = collect_legal_candidates(&after_first, player, params, 0);
        for second in second_options {
            let key = canonical_line_key(&[first, second]);
            if !seen.insert(key) {
                continue;
            }

            if let Some((_, second_winner)) = apply_move_copy(&after_first, second, player) {
                if second_winner == Some(player) {
                    winners.push(vec![first, second]);
                }
            }
        }
    }

    winners
}

fn enumerate_turn_candidates(
    board: &BoardState,
    player: Player,
    params: &EngineParams,
    policy: CandidatePolicy,
    stats: &mut EngineStats,
) -> Vec<RankedLine> {
    if board.placements_left == 0 {
        return Vec::new();
    }

    let winning_lines = collect_winning_turn_lines(board, player, params);
    if !winning_lines.is_empty() {
        stats.nodes_expanded = stats
            .nodes_expanded
            .saturating_add(winning_lines.len() as u32);

        return winning_lines
            .into_iter()
            .map(|line| {
                let (after, _, winner) = apply_turn_line(board, &line, player);
                score_applied_turn(&after, player, line, winner, params, stats)
            })
            .collect();
    }

    let base_eval = evaluate_board_summary(board, params, stats);
    let baseline_opp_wins = opponent_one_turn_wins(&base_eval, player);

    let top_cell_count = policy.top_cell_count.max(1);
    let first_pool = collect_legal_candidates(board, player, params, top_cell_count);
    let first_ranked = rank_placements(board, player, params, &first_pool, stats);
    if first_ranked.is_empty() {
        return Vec::new();
    }

    let top_cell_placements: Vec<RankedPlacement> = first_ranked.into_iter().take(top_cell_count).collect();

    if board.placements_left <= 1 {
        let opponent_finishes = collect_one_turn_finish_cells(&collect_features(&board.moves), player.opponent());
        let filtered: Vec<RankedPlacement> = if !opponent_finishes.is_empty() {
            let subset: Vec<RankedPlacement> = top_cell_placements
                .iter()
                .cloned()
                .filter(|entry| opponent_finishes.contains(&entry.option))
                .collect();
            if subset.is_empty() {
                top_cell_placements.clone()
            } else {
                subset
            }
        } else {
            top_cell_placements.clone()
        };

        let lines: Vec<RankedLine> = filtered
            .into_iter()
            .map(|entry| RankedLine {
                line: vec![entry.option],
                objective: entry.objective,
                own_score: entry.own_score,
                immediate_win: entry.immediate_win,
                opp_one_turn_wins: entry.opp_one_turn_wins,
            })
            .collect();

        let mut pruned = prune_defensively_critical_lines(lines, baseline_opp_wins);
        sort_ranked_lines(&mut pruned);
        stats.nodes_expanded = stats
            .nodes_expanded
            .saturating_add(pruned.len() as u32);
        return pruned;
    }

    let baseline_opp_finish = collect_one_turn_finish_cells(&collect_features(&board.moves), player.opponent());
    let mut lines = Vec::new();
    let mut seen_pair_keys = HashSet::new();

    if !baseline_opp_finish.is_empty() {
        for first_entry in &top_cell_placements {
            let first = first_entry.option;
            let (after_first, first_winner) = match apply_move_copy(board, first, player) {
                Some(value) => value,
                None => continue,
            };

            let second_pool = collect_legal_candidates(&after_first, player, params, top_cell_count);
            let second_ranked = rank_placements(&after_first, player, params, &second_pool, stats)
                .into_iter()
                .take(top_cell_count)
                .collect::<Vec<_>>();

            if second_ranked.is_empty() {
                lines.push(score_applied_turn(
                    &after_first,
                    player,
                    vec![first],
                    first_winner,
                    params,
                    stats,
                ));
                continue;
            }

            for second_entry in second_ranked {
                let second = second_entry.option;
                let pair_key = canonical_line_key(&[first, second]);
                if !seen_pair_keys.insert(pair_key) {
                    continue;
                }

                lines.push(RankedLine {
                    line: vec![first, second],
                    objective: second_entry.objective,
                    own_score: second_entry.own_score,
                    immediate_win: second_entry.immediate_win,
                    opp_one_turn_wins: second_entry.opp_one_turn_wins,
                });
            }
        }

        let mut pruned = prune_defensively_critical_lines(lines, baseline_opp_wins);
        sort_ranked_lines(&mut pruned);
        stats.nodes_expanded = stats
            .nodes_expanded
            .saturating_add(pruned.len() as u32);
        return pruned;
    }

    let top_cells: Vec<Coord> = top_cell_placements.iter().map(|entry| entry.option).collect();

    for first_idx in 0..top_cells.len() {
        for second_idx in (first_idx + 1)..top_cells.len() {
            let first = top_cells[first_idx];
            let second = top_cells[second_idx];
            let pair_key = canonical_line_key(&[first, second]);
            if !seen_pair_keys.insert(pair_key) {
                continue;
            }

            let (after_first, _) = match apply_move_copy(board, first, player) {
                Some(value) => value,
                None => continue,
            };

            let (after_second, second_winner) = match apply_move_copy(&after_first, second, player) {
                Some(value) => value,
                None => continue,
            };

            let eval_result = evaluate_board_summary(&after_second, params, stats);
            lines.push(RankedLine {
                line: vec![first, second],
                objective: objective_for_player(&eval_result, player, params),
                own_score: score_for_player(&eval_result, player),
                immediate_win: second_winner == Some(player),
                opp_one_turn_wins: opponent_one_turn_wins(&eval_result, player),
            });
        }
    }

    if lines.is_empty() {
        if let Some(first) = top_cells.first().copied() {
            let (after, _, winner) = apply_turn_line(board, &[first], player);
            return vec![score_applied_turn(&after, player, vec![first], winner, params, stats)];
        }
        return Vec::new();
    }

    let mut pruned = prune_defensively_critical_lines(lines, baseline_opp_wins);
    sort_ranked_lines(&mut pruned);

    let mut picks = Vec::new();
    let mut unique = HashSet::new();
    let max_line_count = policy.max_line_count.max(1);

    for candidate in pruned {
        let key = canonical_line_key(&candidate.line);
        if !unique.insert(key) {
            continue;
        }
        picks.push(candidate);
        if picks.len() >= max_line_count {
            break;
        }
    }

    stats.nodes_expanded = stats
        .nodes_expanded
        .saturating_add(picks.len() as u32);

    picks
}

fn root_candidate_line_limit(params: &EngineParams) -> usize {
    let requested = params.turn_candidate_count.max(1);
    requested.max(4).min(32)
}

fn root_search_policy(params: &EngineParams) -> CandidatePolicy {
    let line_limit = root_candidate_line_limit(params);
    let top_cell_budget = ((line_limit + 2).max(6)).min((line_limit + 2).max(10));

    CandidatePolicy {
        top_cell_count: widened_top_cell_count(params.top_k_first_moves, top_cell_budget, 2),
        max_line_count: line_limit.max((line_limit * 2).min(16)),
    }
}

fn child_search_policy(params: &EngineParams) -> CandidatePolicy {
    CandidatePolicy {
        top_cell_count: widened_top_cell_count(params.top_k_first_moves, params.child_turn_candidate_count, 2),
        max_line_count: params.child_turn_candidate_count.min(20).max(6),
    }
}

fn choose_best_deterministic_reply(
    board: &BoardState,
    params: &EngineParams,
    stats: &mut EngineStats,
) -> (Option<Vec<Coord>>, f64) {
    let reply_player = board.turn;

    if board.placements_left == 0 {
        let eval = evaluate_board_summary(board, params, stats);
        return (None, objective_for_player(&eval, reply_player, params));
    }

    let reply_limit = params.child_turn_candidate_count.max(3).min(6);
    let mut reply_policy = child_search_policy(params);
    reply_policy.top_cell_count = widened_top_cell_count(params.top_k_first_moves, reply_limit, 2);

    let reply_lines = enumerate_turn_candidates(board, reply_player, params, reply_policy, stats);
    if reply_lines.is_empty() {
        let eval = evaluate_board_summary(board, params, stats);
        return (None, objective_for_player(&eval, reply_player, params));
    }

    let mut best_line = None;
    let mut best_objective = f64::NEG_INFINITY;
    let mut best_own = f64::NEG_INFINITY;

    for candidate in reply_lines {
        let (after_reply, _, winner) = apply_turn_line(board, &candidate.line, reply_player);
        let eval = evaluate_board_summary(&after_reply, params, stats);

        let objective = if winner == Some(reply_player) {
            f64::INFINITY
        } else {
            objective_for_player(&eval, reply_player, params)
        };

        let own_score = score_for_player(&eval, reply_player);

        if objective > best_objective || (objective == best_objective && own_score > best_own) {
            best_line = Some(candidate.line.clone());
            best_objective = objective;
            best_own = own_score;
        }
    }

    (best_line, best_objective)
}

fn choose_deterministic_root_decision(
    board: &BoardState,
    params: &EngineParams,
    stats: &mut EngineStats,
) -> (Vec<Coord>, usize, &'static str) {
    let root_player = board.turn;
    let policy = root_search_policy(params);
    let root_lines = enumerate_turn_candidates(board, root_player, params, policy, stats);

    if root_lines.is_empty() {
        return (Vec::new(), 0, "no_candidates");
    }

    if root_lines.len() == 1 {
        return (root_lines[0].line.clone(), 1, "single_candidate");
    }

    let mut residual = Vec::new();

    for (idx, ranked) in root_lines.iter().enumerate() {
        let (after_root, _, root_winner) = apply_turn_line(board, &ranked.line, root_player);

        let mut residual_objective = ranked.objective;

        if root_winner != Some(root_player) {
            let (reply_line, _) = choose_best_deterministic_reply(&after_root, params, stats);
            if let Some(reply) = reply_line {
                let (after_reply, _, reply_winner) = apply_turn_line(&after_root, &reply, after_root.turn);
                let eval = evaluate_board_summary(&after_reply, params, stats);
                residual_objective = if reply_winner == Some(root_player) {
                    f64::INFINITY
                } else if reply_winner.is_some() {
                    f64::NEG_INFINITY
                } else {
                    objective_for_player(&eval, root_player, params)
                };
            } else {
                let eval = evaluate_board_summary(&after_root, params, stats);
                residual_objective = objective_for_player(&eval, root_player, params);
            }
        }

        residual.push(ResidualRankedLine {
            line: ranked.line.clone(),
            objective: ranked.objective,
            own_score: ranked.own_score,
            immediate_win: ranked.immediate_win,
            initial_rank: idx + 1,
            residual_objective,
        });
    }

    residual.sort_by(|a, b| {
        b.residual_objective
            .total_cmp(&a.residual_objective)
            .then_with(|| b.objective.total_cmp(&a.objective))
            .then_with(|| b.own_score.total_cmp(&a.own_score))
            .then_with(|| b.immediate_win.cmp(&a.immediate_win))
            .then_with(|| a.initial_rank.cmp(&b.initial_rank))
    });

    let best = residual
        .first()
        .map(|entry| entry.line.clone())
        .unwrap_or_default();

    (best, root_lines.len(), "deterministic")
}

fn choose_greedy_turn(board: &BoardState, params: &EngineParams, stats: &mut EngineStats) -> Vec<Coord> {
    let player = board.turn;
    if board.placements_left == 0 {
        return Vec::new();
    }

    let policy = CandidatePolicy {
        top_cell_count: widened_top_cell_count(params.top_k_first_moves, 24, 3),
        max_line_count: 24,
    };

    let mut lines = enumerate_turn_candidates(board, player, params, policy, stats);
    if lines.is_empty() {
        return Vec::new();
    }

    sort_ranked_lines(&mut lines);
    lines
        .first()
        .map(|entry| entry.line.clone())
        .unwrap_or_default()
}

fn broaden_turn_actions(
    board: &BoardState,
    player: Player,
    params: &EngineParams,
    target_count: usize,
    stats: &mut EngineStats,
) -> Vec<Vec<Coord>> {
    if board.placements_left == 0 {
        return Vec::new();
    }

    let target = target_count.max(2).min(64);
    let mut broad_params = params.clone();
    broad_params.candidate_radius = params.candidate_radius.max(params.simulation_radius).max(2);
    broad_params.top_k_first_moves = params
        .top_k_first_moves
        .max(params.simulation_top_k_first_moves)
        .max(6);

    let legal_cells =
        collect_legal_candidates(board, player, &broad_params, target.saturating_mul(3));
    if legal_cells.is_empty() {
        return Vec::new();
    }

    if board.placements_left <= 1 {
        return legal_cells
            .into_iter()
            .take(target)
            .map(|cell| vec![cell])
            .collect();
    }

    let top_cells: Vec<Coord> = legal_cells.into_iter().take((target + 4).min(24)).collect();
    if top_cells.is_empty() {
        return Vec::new();
    }

    let mut ranked = Vec::new();
    let mut seen = HashSet::new();

    for first_idx in 0..top_cells.len() {
        let first = top_cells[first_idx];
        let (after_first, first_winner) = match apply_move_copy(board, first, player) {
            Some(value) => value,
            None => continue,
        };

        if first_winner == Some(player) {
            let key = canonical_line_key(&[first]);
            if seen.insert(key) {
                ranked.push(score_applied_turn(
                    &after_first,
                    player,
                    vec![first],
                    first_winner,
                    &broad_params,
                    stats,
                ));
            }
            continue;
        }

        for second_idx in (first_idx + 1)..top_cells.len() {
            let second = top_cells[second_idx];
            let key = canonical_line_key(&[first, second]);
            if !seen.insert(key) {
                continue;
            }

            let (after_second, second_winner) = match apply_move_copy(&after_first, second, player) {
                Some(value) => value,
                None => continue,
            };

            ranked.push(score_applied_turn(
                &after_second,
                player,
                vec![first, second],
                second_winner,
                &broad_params,
                stats,
            ));
        }
    }

    if ranked.is_empty() {
        return top_cells.first().copied().map(|cell| vec![vec![cell]]).unwrap_or_default();
    }

    sort_ranked_lines(&mut ranked);
    ranked
        .into_iter()
        .take(target)
        .map(|entry| entry.line)
        .collect()
}

fn simulation_search_policy(params: &EngineParams) -> CandidatePolicy {
    CandidatePolicy {
        top_cell_count: widened_top_cell_count(
            params.simulation_top_k_first_moves.max(1),
            params.simulation_turn_candidate_count.max(1),
            1,
        ),
        max_line_count: params.simulation_turn_candidate_count.max(1).min(16),
    }
}

fn player_mark(player: Player) -> char {
    match player {
        Player::X => 'X',
        Player::O => 'O',
    }
}

fn board_state_signature(board: &BoardState) -> String {
    let mut stones: Vec<(i32, i32, Player)> = board
        .moves
        .iter()
        .map(|(&(q, r), &mark)| (q, r, mark))
        .collect();
    stones.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let mut out = String::new();
    out.push('t');
    out.push(':');
    out.push(player_mark(board.turn));
    out.push('|');
    out.push('p');
    out.push(':');
    out.push_str(&board.placements_left.to_string());
    out.push('|');

    for (q, r, mark) in stones {
        out.push_str(&q.to_string());
        out.push(',');
        out.push_str(&r.to_string());
        out.push(',');
        out.push(player_mark(mark));
        out.push(';');
    }

    out
}

fn build_forcing_proof_budget(max_time_ms: u32, max_nodes: u32, start_ms: f64) -> ForcingProofBudget {
    let max_time = max_time_ms.max(1);
    let max_node_count = max_nodes.max(1);

    let time_slice = ((max_time as f64) * 0.2).round() as u32;
    let slice_ms = time_slice.max(40).min(500).min(max_time);

    let node_slice = ((max_node_count as f64) * 0.02).round() as u32;
    let slice_nodes = node_slice.max(64).min(5_000).min(max_node_count);

    ForcingProofBudget {
        deadline_ms: start_ms + slice_ms as f64,
        max_nodes: slice_nodes,
        nodes_visited: 0,
    }
}

fn forcing_status_from_score(score: f64) -> ForcingStatus {
    if score >= FORCING_STATUS_SCORE_BOUNDARY {
        ForcingStatus::Win
    } else if score <= -FORCING_STATUS_SCORE_BOUNDARY {
        ForcingStatus::Loss
    } else {
        ForcingStatus::Unknown
    }
}

fn forcing_heuristic_score(
    board: &BoardState,
    attacker: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
) -> f64 {
    if let Some(winner) = find_winner(&board.moves) {
        return if winner == attacker {
            FORCING_PROVEN_WIN_SCORE
        } else {
            FORCING_PROVEN_LOSS_SCORE
        };
    }

    let eval = evaluate_board_summary(board, params, stats);
    let value = objective_for_player(&eval, attacker, params);
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else if value.is_sign_positive() {
        1.0
    } else {
        -1.0
    }
}

fn should_attempt_forcing_solve(board: &BoardState, attacker: Player) -> bool {
    let features = collect_features(&board.moves);
    if !has_immediate_threats(&features) {
        return false;
    }
    one_turn_blockers_required(&features, attacker) >= 2
}

fn opponent_can_win_immediately(board: &BoardState, player: Player, params: &EngineParams) -> bool {
    !collect_winning_turn_lines(board, player, params).is_empty()
}

fn forcing_candidate_lines(
    board: &BoardState,
    attacker: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
) -> Vec<Vec<Coord>> {
    if board.placements_left == 0 || board.turn != attacker {
        return Vec::new();
    }

    let mut policy = child_search_policy(params);
    policy.top_cell_count = widened_top_cell_count(
        params.top_k_first_moves,
        params.child_turn_candidate_count.max(10).min(24),
        3,
    );
    policy.max_line_count = params.child_turn_candidate_count.max(10).min(24);

    let mut candidates = enumerate_turn_candidates(board, attacker, params, policy, stats)
        .into_iter()
        .map(|entry| entry.line)
        .collect::<Vec<_>>();

    if candidates.len() <= 2 {
        let broadened = broaden_turn_actions(
            board,
            attacker,
            params,
            params.child_turn_candidate_count.max(10).min(24),
            stats,
        );
        if broadened.len() > candidates.len() {
            candidates = broadened;
        }
    }

    let mut seen = HashSet::new();
    let mut forcing = Vec::new();

    for line in candidates {
        let (after_turn, applied, winner) = apply_turn_line(board, &line, attacker);
        if applied.is_empty() {
            continue;
        }

        let key = canonical_line_key(&applied);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }

        let keep = if winner == Some(attacker) {
            true
        } else {
            let features = collect_features(&after_turn.moves);
            let blockers_required = one_turn_blockers_required(&features, attacker);
            let forcing_threshold = after_turn.placements_left.max(1).min(2) as usize;
            blockers_required >= forcing_threshold
        };

        if keep {
            forcing.push(applied);
        }
    }

    forcing
}

fn forcing_child_terminal_result(winner: Option<Player>, attacker: Player) -> ForcingNodeResult {
    match winner {
        Some(player) if player == attacker => ForcingNodeResult {
            status: ForcingStatus::Win,
            score: FORCING_PROVEN_WIN_SCORE,
            best_action: None,
        },
        Some(_) => ForcingNodeResult {
            status: ForcingStatus::Loss,
            score: FORCING_PROVEN_LOSS_SCORE,
            best_action: None,
        },
        None => ForcingNodeResult {
            status: ForcingStatus::Unknown,
            score: 0.0,
            best_action: None,
        },
    }
}

fn forcing_unknown_result(
    board: &BoardState,
    attacker: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
) -> ForcingNodeResult {
    ForcingNodeResult {
        status: ForcingStatus::Unknown,
        score: forcing_heuristic_score(board, attacker, params, stats),
        best_action: None,
    }
}

fn forcing_solve_node(
    board: &BoardState,
    attacker: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
    context: &mut ForcingSearchContext,
    depth_remaining: u8,
    alpha: f64,
    beta: f64,
    is_root: bool,
) -> ForcingNodeResult {
    let depth_used = context.start_depth.saturating_sub(depth_remaining) as u32;
    context.max_depth_turns = context.max_depth_turns.max(depth_used);

    let cache_key = if is_root {
        None
    } else {
        Some(format!(
            "{}|a:{}|d:{}",
            board_state_signature(board),
            player_mark(attacker),
            depth_remaining
        ))
    };

    if let Some(key) = &cache_key {
        if let Some(cached) = context.cache.get(key) {
            context.cache_hits = context.cache_hits.saturating_add(1);
            return ForcingNodeResult {
                status: cached.status,
                score: cached.score,
                best_action: None,
            };
        }
        context.cache_misses = context.cache_misses.saturating_add(1);
    }

    if context.budget.nodes_visited >= context.budget.max_nodes || now_ms() >= context.budget.deadline_ms {
        return forcing_unknown_result(board, attacker, params, stats);
    }
    context.budget.nodes_visited = context.budget.nodes_visited.saturating_add(1);

    if let Some(winner) = find_winner(&board.moves) {
        return forcing_child_terminal_result(Some(winner), attacker);
    }
    if depth_remaining == 0 {
        return forcing_unknown_result(board, attacker, params, stats);
    }

    let current_player = board.turn;
    let defender = attacker.opponent();

    if current_player == defender && opponent_can_win_immediately(board, defender, params) {
        return ForcingNodeResult {
            status: ForcingStatus::Loss,
            score: FORCING_PROVEN_LOSS_SCORE,
            best_action: None,
        };
    }

    let features = collect_features(&board.moves);
    let blockers_required = one_turn_blockers_required(&features, attacker);
    let forcing_threshold = board.placements_left.max(1).min(2) as usize;

    if current_player == defender && blockers_required >= board.placements_left as usize + 1 {
        return ForcingNodeResult {
            status: ForcingStatus::Win,
            score: FORCING_PROVEN_WIN_SCORE,
            best_action: None,
        };
    }

    let result = if current_player == attacker {
        let forcing_lines = forcing_candidate_lines(board, attacker, params, stats);
        if is_root {
            context.root_candidates = forcing_lines.len();
            context.root_line_scores.clear();
        }

        if forcing_lines.is_empty() {
            forcing_unknown_result(board, attacker, params, stats)
        } else {
            let mut best_score = f64::NEG_INFINITY;
            let mut best_status = ForcingStatus::Unknown;
            let mut best_action: Option<Vec<Coord>> = None;
            let mut local_alpha = alpha;

            for line in forcing_lines {
                let (after_turn, applied, winner) = apply_turn_line(board, &line, attacker);
                if applied.is_empty() {
                    continue;
                }

                let child = if winner.is_some() {
                    forcing_child_terminal_result(winner, attacker)
                } else {
                    forcing_solve_node(
                        &after_turn,
                        attacker,
                        params,
                        stats,
                        context,
                        depth_remaining.saturating_sub(1),
                        local_alpha,
                        beta,
                        false,
                    )
                };

                if is_root {
                    context.root_line_scores.push(ForcingLineScore {
                        line: applied.clone(),
                        score: child.score,
                    });
                }

                let should_take = child.score > best_score
                    || (child.score == best_score && child.status == ForcingStatus::Win && best_status != ForcingStatus::Win);
                if should_take {
                    best_score = child.score;
                    best_status = child.status;
                    best_action = Some(applied);
                }

                local_alpha = local_alpha.max(best_score);
                if local_alpha >= beta || best_score >= FORCING_PROVEN_WIN_SCORE {
                    break;
                }
            }

            if best_action.is_none() {
                forcing_unknown_result(board, attacker, params, stats)
            } else {
                let mut status = forcing_status_from_score(best_score);
                if status == ForcingStatus::Unknown {
                    status = best_status;
                }
                ForcingNodeResult {
                    status,
                    score: best_score,
                    best_action,
                }
            }
        }
    } else {
        if blockers_required < forcing_threshold {
            forcing_unknown_result(board, attacker, params, stats)
        } else if blockers_required >= board.placements_left as usize + 1 {
            ForcingNodeResult {
                status: ForcingStatus::Win,
                score: FORCING_PROVEN_WIN_SCORE,
                best_action: None,
            }
        } else {
            let blocking_lines = exact_blocking_responses(board, attacker);
            if blocking_lines.is_empty() {
                ForcingNodeResult {
                    status: ForcingStatus::Win,
                    score: FORCING_PROVEN_WIN_SCORE,
                    best_action: None,
                }
            } else if blocking_lines.len() > FORCING_DEFENDER_BRANCH_CAP {
                forcing_unknown_result(board, attacker, params, stats)
            } else {
                let mut best_score = f64::INFINITY;
                let mut best_status = ForcingStatus::Unknown;
                let mut local_beta = beta;

                for line in blocking_lines {
                    let (after_turn, applied, _) = apply_turn_line(board, &line, current_player);
                    if applied.is_empty() {
                        continue;
                    }

                    let child = forcing_solve_node(
                        &after_turn,
                        attacker,
                        params,
                        stats,
                        context,
                        depth_remaining.saturating_sub(1),
                        alpha,
                        local_beta,
                        false,
                    );

                    let should_take = child.score < best_score
                        || (child.score == best_score && child.status == ForcingStatus::Loss && best_status != ForcingStatus::Loss);
                    if should_take {
                        best_score = child.score;
                        best_status = child.status;
                    }

                    local_beta = local_beta.min(best_score);
                    if alpha >= local_beta || best_score <= FORCING_PROVEN_LOSS_SCORE {
                        break;
                    }
                }

                if best_score == f64::INFINITY {
                    forcing_unknown_result(board, attacker, params, stats)
                } else {
                    let mut status = forcing_status_from_score(best_score);
                    if status == ForcingStatus::Unknown {
                        status = best_status;
                    }
                    ForcingNodeResult {
                        status,
                        score: best_score,
                        best_action: None,
                    }
                }
            }
        }
    };

    if let Some(key) = cache_key {
        context.cache.insert(
            key,
            ForcingCacheEntry {
                status: result.status,
                score: result.score,
            },
        );
    }

    result
}

fn solve_forcing_proof(
    board: &BoardState,
    attacker: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
    max_time_ms: u32,
    max_nodes: u32,
) -> (ForcingSolveResult, ForcingTelemetry) {
    let started_at = now_ms();
    let budget = build_forcing_proof_budget(max_time_ms, max_nodes, started_at);
    let mut context = ForcingSearchContext {
        budget,
        cache: HashMap::new(),
        cache_hits: 0,
        cache_misses: 0,
        start_depth: FORCING_SOLVER_DEPTH,
        max_depth_turns: 0,
        root_candidates: 0,
        root_line_scores: Vec::new(),
    };

    let root = forcing_solve_node(
        board,
        attacker,
        params,
        stats,
        &mut context,
        FORCING_SOLVER_DEPTH,
        FORCING_PROVEN_LOSS_SCORE,
        FORCING_PROVEN_WIN_SCORE,
        true,
    );

    let elapsed_ms = (now_ms() - started_at).max(0.0).round() as u32;
    let telemetry = ForcingTelemetry {
        attempted: true,
        status: root.status,
        nodes: context.budget.nodes_visited,
        cache_hits: context.cache_hits,
        cache_misses: context.cache_misses,
        elapsed_ms,
        root_candidates: context.root_candidates,
        max_depth_turns: context.max_depth_turns,
    };

    (
        ForcingSolveResult {
            status: root.status,
            best_action: root.best_action,
            root_line_scores: context.root_line_scores,
        },
        telemetry,
    )
}

fn sort_root_actions_by_forcing_scores(actions: &mut [Vec<Coord>], line_scores: &[ForcingLineScore]) {
    if actions.is_empty() || line_scores.is_empty() {
        return;
    }

    let mut score_by_key: HashMap<String, f64> = HashMap::new();
    for entry in line_scores {
        let key = canonical_line_key(&entry.line);
        if key.is_empty() {
            continue;
        }
        let previous = score_by_key.get(&key).copied().unwrap_or(f64::NEG_INFINITY);
        if entry.score > previous {
            score_by_key.insert(key, entry.score);
        }
    }

    actions.sort_by(|a, b| {
        let a_key = canonical_line_key(a);
        let b_key = canonical_line_key(b);
        let a_score = score_by_key.get(&a_key).copied().unwrap_or(f64::NEG_INFINITY);
        let b_score = score_by_key.get(&b_key).copied().unwrap_or(f64::NEG_INFINITY);
        b_score
            .total_cmp(&a_score)
            .then_with(|| a_key.cmp(&b_key))
    });
}

fn terminal_value_for_root(winner: Option<Player>, root_player: Player) -> f64 {
    match winner {
        Some(player) if player == root_player => 1.0,
        Some(_) => -1.0,
        None => 0.0,
    }
}

fn rollout_leaf_value(
    board: &BoardState,
    root_player: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
    start_depth_turns: u32,
    max_depth_turns: &mut u32,
) -> f64 {
    if let Some(winner) = find_winner(&board.moves) {
        return terminal_value_for_root(Some(winner), root_player);
    }

    let mut simulation_board = board.clone();
    let mut sim_depth = 0_u32;
    let mut simulation_params = params.clone();
    simulation_params.candidate_radius = params.simulation_radius;
    simulation_params.top_k_first_moves = params.simulation_top_k_first_moves.max(1);

    while sim_depth < params.max_simulation_turns as u32 {
        if simulation_board.placements_left == 0 {
            break;
        }

        let player = simulation_board.turn;
        let policy = simulation_search_policy(&simulation_params);
        let mut lines = enumerate_turn_candidates(
            &simulation_board,
            player,
            &simulation_params,
            policy,
            stats,
        );
        if lines.is_empty() {
            break;
        }

        sort_ranked_lines(&mut lines);
        let selected_line = lines[0].line.clone();
        let (after_turn, _, winner) = apply_turn_line(&simulation_board, &selected_line, player);
        simulation_board = after_turn;
        sim_depth = sim_depth.saturating_add(1);
        *max_depth_turns = (*max_depth_turns).max(start_depth_turns.saturating_add(sim_depth));

        if winner.is_some() {
            return terminal_value_for_root(winner, root_player);
        }
    }

    let eval_result = evaluate_board_summary(&simulation_board, params, stats);
    let value = objective_for_player(&eval_result, root_player, params);
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else if value.is_sign_positive() {
        1.0
    } else {
        -1.0
    }
}

fn select_uct_child(
    nodes: &[MctsNode],
    parent_idx: usize,
    root_player: Player,
    exploration_c: f64,
) -> Option<usize> {
    let parent = &nodes[parent_idx];
    if parent.children.is_empty() {
        return None;
    }

    let parent_visits = parent.visits.max(1) as f64;
    let maximize_root_objective = parent.player_to_move == root_player;
    let c = exploration_c.max(0.0);

    let mut best_child = None;
    let mut best_score = f64::NEG_INFINITY;

    for &child_idx in &parent.children {
        let child = &nodes[child_idx];
        let score = if child.visits == 0 {
            f64::INFINITY
        } else {
            let mean = child.total_value / child.visits as f64;
            let oriented_mean = if maximize_root_objective { mean } else { -mean };
            let exploration = c * ((parent_visits.ln() / child.visits as f64).sqrt());
            oriented_mean + exploration
        };

        if score > best_score {
            best_score = score;
            best_child = Some(child_idx);
        }
    }

    best_child
}

fn ensure_node_actions(
    nodes: &mut [MctsNode],
    node_idx: usize,
    board: &BoardState,
    params: &EngineParams,
    stats: &mut EngineStats,
) {
    if nodes[node_idx].unexpanded_actions.is_some() {
        return;
    }

    let policy = if nodes[node_idx].parent.is_none() {
        root_search_policy(params)
    } else {
        child_search_policy(params)
    };
    let player = nodes[node_idx].player_to_move;
    let mut actions = enumerate_turn_candidates(board, player, params, policy, stats)
        .into_iter()
        .map(|entry| entry.line)
        .collect::<Vec<_>>();

    if actions.len() <= 1 {
        let broaden_target = if nodes[node_idx].parent.is_none() {
            params.turn_candidate_count.max(8).min(40)
        } else {
            params.child_turn_candidate_count.max(6).min(20)
        };
        let broadened = broaden_turn_actions(board, player, params, broaden_target, stats);
        if broadened.len() > actions.len() {
            actions = broadened;
        }
    }

    actions.reverse();

    nodes[node_idx].unexpanded_actions = Some(actions);
}

fn select_expand_path(
    root_board: &BoardState,
    nodes: &mut Vec<MctsNode>,
    root_player: Player,
    params: &EngineParams,
    stats: &mut EngineStats,
    depth_cap: u32,
    max_depth_turns: &mut u32,
) -> (Vec<usize>, BoardState, bool) {
    let mut board = root_board.clone();
    let mut path = vec![0_usize];
    let mut node_idx = 0_usize;
    let mut expanded = false;

    loop {
        let node_depth = nodes[node_idx].depth_turns;
        *max_depth_turns = (*max_depth_turns).max(node_depth);

        if nodes[node_idx].terminal_winner.is_some() || node_depth >= depth_cap {
            break;
        }

        ensure_node_actions(nodes, node_idx, &board, params, stats);

        let mut expanded_here = false;
        loop {
            let action_opt = {
                let Some(actions) = nodes[node_idx].unexpanded_actions.as_mut() else {
                    break;
                };
                actions.pop()
            };

            let Some(action) = action_opt else {
                break;
            };

            let player = nodes[node_idx].player_to_move;
            let (next_board, applied, winner) = apply_turn_line(&board, &action, player);
            if applied.is_empty() {
                continue;
            }

            let child_idx = nodes.len();
            let child_depth = nodes[node_idx].depth_turns.saturating_add(1);
            nodes.push(MctsNode {
                parent: Some(node_idx),
                action_from_parent: applied.clone(),
                player_to_move: next_board.turn,
                depth_turns: child_depth,
                children: Vec::new(),
                unexpanded_actions: None,
                visits: 0,
                total_value: 0.0,
                terminal_winner: winner.or_else(|| find_winner(&next_board.moves)),
            });
            nodes[node_idx].children.push(child_idx);

            board = next_board;
            node_idx = child_idx;
            path.push(child_idx);
            *max_depth_turns = (*max_depth_turns).max(child_depth);
            expanded = true;
            expanded_here = true;
            break;
        }

        if expanded_here {
            break;
        }

        let Some(child_idx) = select_uct_child(nodes, node_idx, root_player, params.exploration_c) else {
            break;
        };

        let player = nodes[node_idx].player_to_move;
        let action = nodes[child_idx].action_from_parent.clone();
        let (next_board, applied, winner) = apply_turn_line(&board, &action, player);
        if applied.is_empty() {
            break;
        }
        if nodes[child_idx].terminal_winner.is_none() && winner.is_some() {
            nodes[child_idx].terminal_winner = winner;
        }

        board = next_board;
        node_idx = child_idx;
        path.push(child_idx);
    }

    (path, board, expanded)
}

fn choose_mcts_turn(
    board: &BoardState,
    params: &EngineParams,
    max_time_ms: u32,
    max_nodes: u32,
    stats: &mut EngineStats,
) -> (Vec<Coord>, usize, &'static str, u32, u32, ForcingTelemetry) {
    if board.placements_left == 0 {
        return (Vec::new(), 0, "terminal", 0, 0, ForcingTelemetry::default());
    }

    let root_player = board.turn;
    let mut forcing_telemetry = ForcingTelemetry::default();
    let mut forcing_line_scores = Vec::new();

    if should_attempt_forcing_solve(board, root_player) {
        let (forcing_result, telemetry) =
            solve_forcing_proof(board, root_player, params, stats, max_time_ms, max_nodes);
        forcing_line_scores = forcing_result.root_line_scores;
        forcing_telemetry = telemetry;

        if forcing_result.status == ForcingStatus::Win {
            if let Some(best_action) = forcing_result.best_action {
                if !best_action.is_empty() {
                    return (
                        best_action,
                        forcing_telemetry.root_candidates.max(1),
                        "early_win",
                        forcing_telemetry.max_depth_turns.max(1),
                        0,
                        forcing_telemetry,
                    );
                }
            }
        }
    }

    let root_policy = root_search_policy(params);
    let mut root_actions = enumerate_turn_candidates(board, root_player, params, root_policy, stats)
        .into_iter()
        .map(|entry| entry.line)
        .collect::<Vec<_>>();

    if root_actions.len() <= 1 {
        let broadened = broaden_turn_actions(
            board,
            root_player,
            params,
            params.turn_candidate_count.max(10).min(48),
            stats,
        );
        if broadened.len() > root_actions.len() {
            root_actions = broadened;
        }
    }

    if !forcing_line_scores.is_empty() {
        sort_root_actions_by_forcing_scores(&mut root_actions, &forcing_line_scores);
    }

    if root_actions.is_empty() {
        return (Vec::new(), 0, "no_candidates", 0, 0, forcing_telemetry);
    }

    let seed_move = root_actions.first().cloned().unwrap_or_default();

    if root_actions.len() == 1 {
        return (root_actions[0].clone(), 1, "single_candidate", 1, 0, forcing_telemetry);
    }

    let root_candidates = root_actions.len();
    root_actions.reverse();

    let remaining_time_ms = max_time_ms.saturating_sub(forcing_telemetry.elapsed_ms);
    let remaining_node_budget = max_nodes.saturating_sub(forcing_telemetry.nodes);
    if remaining_time_ms == 0 || remaining_node_budget == 0 {
        return (
            seed_move,
            root_candidates,
            if remaining_time_ms == 0 { "time" } else { "nodes" },
            forcing_telemetry.max_depth_turns,
            0,
            forcing_telemetry,
        );
    }

    let mut nodes = vec![MctsNode {
        parent: None,
        action_from_parent: Vec::new(),
        player_to_move: root_player,
        depth_turns: 0,
        children: Vec::new(),
        unexpanded_actions: Some(root_actions),
        visits: 0,
        total_value: 0.0,
        terminal_winner: find_winner(&board.moves),
    }];

    let started_at_ms = now_ms();
    let budget_ms = (remaining_time_ms as f64).max(1.0);
    let node_budget = remaining_node_budget.max(1).min(2_000_000);
    let depth_cap = (params.max_simulation_turns as u32).saturating_add(4).max(4).min(24);

    let mut playouts = 0_u32;
    let mut max_depth_turns = forcing_telemetry.max_depth_turns;
    let mut stop_reason: &'static str = "time";

    while playouts < node_budget {
        if now_ms() - started_at_ms >= budget_ms {
            stop_reason = "time";
            break;
        }
        if nodes.len() as u32 >= node_budget {
            stop_reason = "nodes";
            break;
        }

        let (path, leaf_board, _expanded) = select_expand_path(
            board,
            &mut nodes,
            root_player,
            params,
            stats,
            depth_cap,
            &mut max_depth_turns,
        );

        if path.is_empty() {
            stop_reason = "fallback";
            break;
        }

        let leaf_idx = *path.last().unwrap_or(&0);
        let value = if let Some(winner) = nodes[leaf_idx].terminal_winner {
            terminal_value_for_root(Some(winner), root_player)
        } else {
            rollout_leaf_value(
                &leaf_board,
                root_player,
                params,
                stats,
                nodes[leaf_idx].depth_turns,
                &mut max_depth_turns,
            )
        };

        for node_on_path in path {
            let node = &mut nodes[node_on_path];
            node.visits = node.visits.saturating_add(1);
            node.total_value += value;
        }

        playouts = playouts.saturating_add(1);
    }

    if playouts >= node_budget || nodes.len() as u32 >= node_budget {
        stop_reason = "nodes";
    } else if now_ms() - started_at_ms >= budget_ms {
        stop_reason = "time";
    } else if playouts == 0 {
        stop_reason = "fallback";
    }

    stats.nodes_expanded = stats
        .nodes_expanded
        .saturating_add(nodes.len().saturating_sub(1) as u32);

    let root = &nodes[0];
    if root.children.is_empty() {
        return (
            seed_move,
            root_candidates,
            if playouts == 0 { "fallback" } else { stop_reason },
            max_depth_turns,
            playouts,
            forcing_telemetry,
        );
    }

    let mut best_child_idx = root.children[0];
    for &candidate_idx in &root.children[1..] {
        let best = &nodes[best_child_idx];
        let candidate = &nodes[candidate_idx];

        if candidate.visits > best.visits {
            best_child_idx = candidate_idx;
            continue;
        }
        if candidate.visits == best.visits {
            let best_mean = if best.visits == 0 {
                f64::NEG_INFINITY
            } else {
                best.total_value / best.visits as f64
            };
            let candidate_mean = if candidate.visits == 0 {
                f64::NEG_INFINITY
            } else {
                candidate.total_value / candidate.visits as f64
            };
            if candidate_mean > best_mean {
                best_child_idx = candidate_idx;
            }
        }
    }

    let best_line = nodes[best_child_idx].action_from_parent.clone();
    let best_depth = nodes[best_child_idx].depth_turns;
    (
        best_line,
        root_candidates,
        stop_reason,
        max_depth_turns.max(best_depth),
        playouts,
        forcing_telemetry,
    )
}

fn sanitize_selected_moves(board: &BoardState, proposed: &[Coord]) -> Vec<Coord> {
    let mut occupied = board.moves.clone();
    let mut deduped = HashSet::new();
    let limit = board.placements_left.max(1) as usize;
    let mut selected = Vec::new();

    for &coord in proposed {
        if selected.len() >= limit {
            break;
        }
        if occupied.contains_key(&coord) || !deduped.insert(coord) {
            continue;
        }
        occupied.insert(coord, board.turn);
        selected.push(coord);
    }

    selected
}

fn choose_turn_internal(request: ChooseTurnRequest) -> Result<ChooseTurnResponse, String> {
    let turn = parse_player(&request.turn).ok_or_else(|| "turn must be X or O".to_owned())?;
    let params = normalize_params(&request);
    let max_time_ms = request.max_time_ms.unwrap_or(0);
    let max_nodes = request.max_nodes.unwrap_or(0);

    let mut moves_map: BoardMap = HashMap::new();
    let mut move_history = Vec::new();

    for cell in request.moves {
        let mark = parse_player(&cell.mark)
            .ok_or_else(|| format!("invalid mark '{}' at {},{}", cell.mark, cell.q, cell.r))?;
        let coord = (cell.q, cell.r);
        if !moves_map.contains_key(&coord) {
            move_history.push(PlacedMove {
                q: cell.q,
                r: cell.r,
            });
        }
        moves_map.insert(coord, mark);
    }

    let mut board = BoardState {
        moves: moves_map,
        move_history,
        turn,
        placements_left: request.placements_left.max(1).min(2),
    };

    let mut stats = EngineStats::default();

    if find_winner(&board.moves).is_some() {
        return Ok(ChooseTurnResponse {
            moves: Vec::new(),
            mode: "beam",
            stop_reason: "terminal",
            nodes_expanded: 0,
            playouts: 0,
            board_evaluations: 0,
            root_candidates: 0,
            max_depth_turns: 0,
            forcing_status: "not_attempted",
            forcing_nodes: 0,
            forcing_cache_hits: 0,
            forcing_cache_misses: 0,
            forcing_elapsed_ms: 0,
            forcing_root_candidates: 0,
        });
    }

    let (derived_turn, derived_placements) = turn_state_from_move_count(board.moves.len());
    if derived_turn != board.turn {
        board.turn = derived_turn;
    }
    if board.placements_left > derived_placements {
        board.placements_left = derived_placements;
    }

    if board.placements_left == 0 {
        return Ok(ChooseTurnResponse {
            moves: Vec::new(),
            mode: "beam",
            stop_reason: "terminal",
            nodes_expanded: stats.nodes_expanded,
            playouts: 0,
            board_evaluations: stats.board_evaluations,
            root_candidates: 0,
            max_depth_turns: 0,
            forcing_status: "not_attempted",
            forcing_nodes: 0,
            forcing_cache_hits: 0,
            forcing_cache_misses: 0,
            forcing_elapsed_ms: 0,
            forcing_root_candidates: 0,
        });
    }

    let (proposed_moves, root_candidates, stop_reason, mode, max_depth_turns, playouts, forcing) = if max_time_ms == 0 || max_nodes == 0 {
        (
            choose_greedy_turn(&board, &params, &mut stats),
            0,
            "budget_zero",
            "greedy",
            0,
            0,
            ForcingTelemetry::default(),
        )
    } else {
        let (moves, root_candidates, reason, depth_turns, playout_count, forcing) =
            choose_mcts_turn(&board, &params, max_time_ms, max_nodes, &mut stats);
        if !moves.is_empty() {
            (moves, root_candidates, reason, "mcts", depth_turns, playout_count, forcing)
        } else {
            (
                choose_greedy_turn(&board, &params, &mut stats),
                root_candidates,
                if root_candidates == 0 { "no_candidates" } else { "fallback" },
                "mcts",
                depth_turns,
                playout_count,
                forcing,
            )
        }
    };

    let selected = sanitize_selected_moves(&board, &proposed_moves);

    let response = ChooseTurnResponse {
        moves: selected
            .into_iter()
            .map(|(q, r)| MoveChoice { q, r })
            .collect(),
        mode,
        stop_reason,
        nodes_expanded: stats.nodes_expanded,
        playouts,
        board_evaluations: stats.board_evaluations,
        root_candidates: root_candidates as u32,
        max_depth_turns,
        forcing_status: if forcing.attempted {
            forcing.status.as_str()
        } else {
            "not_attempted"
        },
        forcing_nodes: forcing.nodes,
        forcing_cache_hits: forcing.cache_hits,
        forcing_cache_misses: forcing.cache_misses,
        forcing_elapsed_ms: forcing.elapsed_ms,
        forcing_root_candidates: forcing.root_candidates as u32,
    };

    Ok(response)
}

#[wasm_bindgen]
pub fn choose_turn_json(input_json: &str) -> String {
    let parsed: ChooseTurnRequest = match serde_json::from_str(input_json) {
        Ok(value) => value,
        Err(error) => {
            return to_error_json(format!("invalid request JSON: {}", error));
        }
    };

    match choose_turn_internal(parsed) {
        Ok(response) => serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"error\":\"response serialization failed\"}".to_owned()),
        Err(error) => to_error_json(error),
    }
}
