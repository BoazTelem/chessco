/**
 * Refund auto-resolution decision tree (spec §11).
 *
 * Filed refunds carry a categorical reasonCode + optional evidence. Some
 * reasons resolve automatically within 60s of filing:
 *
 *   - opponent_abandoned        — auto-approve if match.status reflects
 *                                 a server-confirmed disconnect timeout.
 *   - opponent_didnt_play_position — auto-approve if first FEN logged by
 *                                 realtime ≠ challenge.fen (FEN mismatch).
 *   - technical_failure         — escalate to manual review (cannot auto-
 *                                 confirm; needs human inspection).
 *   - engine_assistance_suspected — escalate; fairplay queue handles.
 *   - harassment                — escalate; admin review.
 *   - other                     — escalate.
 *
 * Pure function. Caller provides the match facts; this module emits an
 * AutoResolutionDecision the refund route persists onto refund_requests.
 */

export type RefundReasonCode =
  | 'opponent_abandoned'
  | 'opponent_didnt_play_position'
  | 'engine_assistance_suspected'
  | 'harassment'
  | 'technical_failure'
  | 'other';

export interface MatchFacts {
  matchStatus:
    | 'accepted'
    | 'starting'
    | 'live'
    | 'completed'
    | 'aborted'
    | 'abandoned'
    | 'creator_abandoned'
    | 'disputed'
    | 'settled';
  /** Whose disconnect triggered an abandonment, if any. */
  abandonedBy: 'opponent' | 'creator' | null;
  challengeFen: string;
  /** First FEN the realtime server logged as the actual starting FEN. */
  firstObservedFen: string | null;
  filerProfileId: string;
  creatorProfileId: string;
  opponentProfileId: string;
}

export type AutoResolutionRule =
  | 'opp_disconnect_confirmed'
  | 'fen_mismatch_detected'
  | 'no_auto_rule_matched';

export interface AutoResolutionDecision {
  status: 'auto_approved' | 'under_review';
  rule: AutoResolutionRule;
  explanation: string;
}

function normalizeFen(fen: string): string {
  // Halfmove + fullmove counters don't change the position; trim them so
  // a 7-segment FEN matches a 4-segment one.
  return fen.split(' ').slice(0, 4).join(' ');
}

export function resolveRefundAutomatically(
  reasonCode: RefundReasonCode,
  match: MatchFacts,
): AutoResolutionDecision {
  // Filer must be the creator (the party who paid the escrow). The route
  // layer rejects non-creators before reaching this function, but defend
  // here too so the decision is robust.
  if (match.filerProfileId !== match.creatorProfileId) {
    return {
      status: 'under_review',
      rule: 'no_auto_rule_matched',
      explanation: 'Refund filer is not the creator; auto-rules only apply to creators.',
    };
  }

  switch (reasonCode) {
    case 'opponent_abandoned': {
      if (match.matchStatus === 'abandoned' && match.abandonedBy === 'opponent') {
        return {
          status: 'auto_approved',
          rule: 'opp_disconnect_confirmed',
          explanation:
            'Match status is `abandoned` with abandonedBy=opponent, indicating a server-confirmed disconnect past the 60s grace.',
        };
      }
      return {
        status: 'under_review',
        rule: 'no_auto_rule_matched',
        explanation: 'Opponent abandonment was not server-confirmed; manual review required.',
      };
    }

    case 'opponent_didnt_play_position': {
      if (
        match.firstObservedFen &&
        normalizeFen(match.firstObservedFen) !== normalizeFen(match.challengeFen)
      ) {
        return {
          status: 'auto_approved',
          rule: 'fen_mismatch_detected',
          explanation: `First observed FEN (${match.firstObservedFen}) does not match challenge FEN (${match.challengeFen}).`,
        };
      }
      return {
        status: 'under_review',
        rule: 'no_auto_rule_matched',
        explanation: 'First observed FEN matches challenge FEN; cannot auto-resolve.',
      };
    }

    case 'technical_failure':
    case 'engine_assistance_suspected':
    case 'harassment':
    case 'other':
      return {
        status: 'under_review',
        rule: 'no_auto_rule_matched',
        explanation: 'Reason code requires human review; routed to /admin/refunds.',
      };
  }
}
