// ============================================================
// Passenger-rights eligibility engine
// ------------------------------------------------------------
// Given a flight + issue description, evaluates the claim against
// 6 major regulations and returns per-regulation verdicts. The
// UI layer turns this object into a results screen.
//
// Each sub-evaluator returns:
//   { regulation, applicable, compensation, reasoning }
// - `applicable: true` means the regulation covers this claim and
//   an amount/remedy is being proposed.
// - `compensation` is null when not applicable OR when the
//   regulation covers the case but no fixed amount is due
//   (e.g. a short delay that still entitles you to care).
// - `reasoning` is plain-English and cites the rule.
// ============================================================

import { haversineDistance } from './distance.js';
import {
  isEUorAssociated,
  isUK,
  isCanada,
  isBrazil,
  isIsrael,
} from './jurisdictions.js';

const REG = {
  EU261: 'EU261',
  UK261: 'UK261',
  APPR: 'APPR (Canada)',
  MONTREAL: 'Montreal Convention',
  ANAC: 'ANAC 400/2022 (Brazil)',
  ISRAEL: 'Israel Aviation Services Law',
};

// Jurisdictions where a purely domestic flight has no comparable
// fixed-compensation law. Used by out-of-scope detection.
const ASIAN_DOMESTIC_CODES = [
  'JP', 'KR', 'CN', 'SG', 'TH', 'VN', 'ID', 'PH', 'MY', 'IN', 'HK', 'TW',
];

// ---------- Tier helpers ----------

// EU261 Article 7(1) — fixed tiers by great-circle distance.
// Intra-EU cap: even for distance >1500 km, €400 is the ceiling.
function eu261TierAmount(distance, intraEu) {
  if (distance <= 1500) return 250;
  if (intraEu) return 400;
  if (distance <= 3500) return 400;
  return 600;
}

// UK261 — post-Brexit UK adoption of the EU261 structure in GBP.
function uk261TierAmount(distance) {
  if (distance <= 1500) return 220;
  if (distance <= 3500) return 350;
  return 520;
}

// Israeli ASL tiers (approximate; underlying law indexes these in ILS).
function israelTierAmount(distance) {
  if (distance <= 2000) return 1250;
  if (distance <= 4500) return 2000;
  return 3130;
}

// EU261/UK261 Article 10 — downgrade refund percentage of ticket price.
function downgradePercentage(distance) {
  if (distance <= 1500) return 30;
  if (distance <= 3500) return 50;
  return 75;
}

// Shared "extraordinary circumstances" assessment for delayed/cancelled
// paths under EU261/UK261/APPR. Returns:
//   exempt: true        — the reason is typically exempting
//   exempt: false       — the reason is NOT exempting
//   exempt: 'contested' — depends on facts; courts have split both ways
//   exempt: 'depends'   — depends on who/what triggered it
function extraordinaryCircumstancesAssessment(reason) {
  switch (reason) {
    case 'weather':
      return {
        exempt: 'contested',
        note:
          'Weather is contested — the ECJ has ruled that routine adverse weather is not extraordinary; only severe/unpredictable conditions count.',
      };
    case 'security_atc':
      return {
        exempt: true,
        note:
          'Security, ATC directives, and airport closures are typically outside the airline\u2019s control and qualify as extraordinary circumstances.',
      };
    case 'strike':
      return {
        exempt: 'depends',
        note:
          'ATC / airport-staff strikes are usually exempting. Airline-crew strikes are NOT exempting (ECJ Kr\u00fcsemann, 2018).',
      };
    case 'technical':
      return {
        exempt: false,
        note:
          'Technical/mechanical faults are well-established NOT to be extraordinary circumstances (ECJ Wallentin-Hermann 2008, van der Lans 2015).',
      };
    case 'operational':
      return {
        exempt: false,
        note:
          'Operational issues (crew shortage, scheduling, overbooking knock-on) are within the airline\u2019s control and do NOT exempt.',
      };
    case 'unknown':
    default:
      return {
        exempt: false,
        note:
          'No clear reason was given. The burden of proof is on the airline to establish extraordinary circumstances; until they do, compensation is presumed due.',
      };
  }
}

function notApplicable(regulation, reasoning) {
  return { regulation, applicable: false, compensation: null, reasoning };
}

// ============================================================
// EU261 — EC Regulation 261/2004
// ============================================================
function evaluateEU261(input, distance, intraEu) {
  const originEU = isEUorAssociated(input.origin.country);
  const destEU = isEUorAssociated(input.destination.country);
  const airlineEU = isEUorAssociated(input.airline.country);
  const applies = originEU || (destEU && airlineEU);

  if (!applies) {
    return notApplicable(
      REG.EU261,
      'EU261 applies when a flight departs from the EU/EEA/CH, or when it arrives in the EU/EEA/CH on an EU/EEA/CH-registered carrier. Your route/airline combination does not meet either condition.',
    );
  }

  const tier = eu261TierAmount(distance, intraEu);

  switch (input.issueType) {
    case 'delayed': {
      if (['under_2h', '2_to_3h'].includes(input.delayDuration)) {
        return notApplicable(
          REG.EU261,
          `EU261 requires an arrival delay of at least 3 hours for fixed compensation (Sturgeon/Nelson rulings). Your reported delay (${humanDelay(input.delayDuration)}) is below the threshold. You may still be entitled to care (meals, rebooking, accommodation) under Article 9.`,
        );
      }
      const ec = extraordinaryCircumstancesAssessment(input.disruptionReason);
      if (ec.exempt === true) {
        return notApplicable(
          REG.EU261,
          `EU261 covers this route, but "${input.disruptionReason}" is typically an exempting extraordinary circumstance. ${ec.note}`,
        );
      }

      // Article 7(2)(c): for 3-4h delays on long-haul (>3500 km), compensation is halved.
      let amount = tier;
      let note = `Distance ${distance} km \u2192 \u20ac${tier} tier.`;
      if (input.delayDuration === '3_to_4h' && distance > 3500) {
        amount = tier / 2;
        note += ` Article 7(2)(c) halves 3-4h delays on flights >3500 km, so \u20ac${amount} applies here.`;
      }

      const reasonNote =
        ec.exempt === 'contested' || ec.exempt === 'depends'
          ? ` \u26a0 The airline may claim extraordinary circumstances: ${ec.note}`
          : ` ${ec.note}`;

      return {
        regulation: REG.EU261,
        applicable: true,
        compensation: { type: 'fixed', amount, currency: 'EUR' },
        reasoning: `EU261 Article 7 applies. ${note} Arrival delay of ${humanDelay(input.delayDuration)} \u2192 compensation due.${reasonNote}`,
      };
    }

    case 'cancelled': {
      if (input.notificationTiming === '14d_plus') {
        return notApplicable(
          REG.EU261,
          'EU261 Article 5(1)(c)(i): no compensation is due if the airline notified you at least 14 days before the flight. You still have the right to a refund or free rerouting.',
        );
      }
      const ec = extraordinaryCircumstancesAssessment(input.disruptionReason);
      if (ec.exempt === true) {
        return notApplicable(
          REG.EU261,
          `EU261 covers this route, but "${input.disruptionReason}" is typically an exempting extraordinary circumstance. ${ec.note}`,
        );
      }
      const reasonNote =
        ec.exempt === 'contested' || ec.exempt === 'depends'
          ? ` \u26a0 ${ec.note}`
          : ` ${ec.note}`;

      // For 7-13d notice, compensation hinges on whether the reroute arrived
      // within acceptable limits (Article 5(1)(c)(ii)). We don't capture reroute
      // delay, so we stay applicable and surface the caveat in the reasoning.
      const reroutingCaveat =
        input.notificationTiming === '7_to_13d'
          ? ' \u2014 with 7\u201313 days notice, EU261 Article 5(1)(c)(ii) only excuses the airline if the reroute got you close to your original schedule. If the reroute arrived >2-4h late (depending on distance), compensation is still due.'
          : '';

      return {
        regulation: REG.EU261,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'EUR' },
        reasoning: `EU261 Article 5 applies. Notification: ${humanNotification(input.notificationTiming)}. Distance ${distance} km \u2192 \u20ac${tier} tier.${reroutingCaveat}${reasonNote}`,
      };
    }

    case 'denied_boarding': {
      if (input.deniedBoardingType !== 'involuntary') {
        return notApplicable(
          REG.EU261,
          'EU261 Article 4 covers only INVOLUNTARY denied boarding. Voluntary denied boarding is governed by the terms you agreed to when accepting the airline\u2019s offer.',
        );
      }
      return {
        regulation: REG.EU261,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'EUR' },
        reasoning: `EU261 Article 4: involuntary denied boarding (e.g. overbooking) entitles you to fixed compensation regardless of the resulting delay. Distance ${distance} km \u2192 \u20ac${tier}.`,
      };
    }

    case 'downgraded': {
      const pct = downgradePercentage(distance);
      return {
        regulation: REG.EU261,
        applicable: true,
        compensation: {
          type: 'percentage',
          value: pct,
          basis: 'ticket_price',
          currency: 'EUR',
        },
        reasoning: `EU261 Article 10: you must be reimbursed ${pct}% of the ticket price for the downgraded segment (distance ${distance} km). No extraordinary-circumstances defense applies to downgrades. Actual amount depends on your ticket price.`,
      };
    }

    default:
      return notApplicable(
        REG.EU261,
        'Could not determine — missing or unrecognised issue type.',
      );
  }
}

// ============================================================
// UK261 — Air Passenger Rights & Air Travel Organisers\u2019 Licensing Regs
// ============================================================
function evaluateUK261(input, distance) {
  const applies =
    isUK(input.origin.country) ||
    (isUK(input.destination.country) && isUK(input.airline.country));

  if (!applies) {
    return notApplicable(
      REG.UK261,
      'UK261 applies when a flight departs from the UK, or when it arrives in the UK on a UK-registered carrier. Your route/airline combination does not meet either condition.',
    );
  }

  const tier = uk261TierAmount(distance);

  switch (input.issueType) {
    case 'delayed': {
      if (['under_2h', '2_to_3h'].includes(input.delayDuration)) {
        return notApplicable(
          REG.UK261,
          `UK261 requires an arrival delay of at least 3 hours for fixed compensation. Your reported delay (${humanDelay(input.delayDuration)}) is below the threshold.`,
        );
      }
      const ec = extraordinaryCircumstancesAssessment(input.disruptionReason);
      if (ec.exempt === true) {
        return notApplicable(
          REG.UK261,
          `UK261 covers this route, but "${input.disruptionReason}" is typically exempting. ${ec.note}`,
        );
      }
      let amount = tier;
      let note = `Distance ${distance} km \u2192 \u00a3${tier} tier.`;
      if (input.delayDuration === '3_to_4h' && distance > 3500) {
        amount = tier / 2;
        note += ` UK261 halves 3-4h delays on flights >3500 km, so \u00a3${amount} applies here.`;
      }
      const reasonNote =
        ec.exempt === 'contested' || ec.exempt === 'depends'
          ? ` \u26a0 ${ec.note}`
          : ` ${ec.note}`;
      return {
        regulation: REG.UK261,
        applicable: true,
        compensation: { type: 'fixed', amount, currency: 'GBP' },
        reasoning: `UK261 applies. ${note} Arrival delay of ${humanDelay(input.delayDuration)} \u2192 compensation due.${reasonNote}`,
      };
    }

    case 'cancelled': {
      if (input.notificationTiming === '14d_plus') {
        return notApplicable(
          REG.UK261,
          'UK261: no compensation is due if the airline notified you at least 14 days before the flight.',
        );
      }
      const ec = extraordinaryCircumstancesAssessment(input.disruptionReason);
      if (ec.exempt === true) {
        return notApplicable(
          REG.UK261,
          `UK261 covers this route, but "${input.disruptionReason}" is typically exempting. ${ec.note}`,
        );
      }
      const reasonNote =
        ec.exempt === 'contested' || ec.exempt === 'depends'
          ? ` \u26a0 ${ec.note}`
          : ` ${ec.note}`;
      const reroutingCaveat =
        input.notificationTiming === '7_to_13d'
          ? ' \u2014 with 7\u201313 days notice, UK261 only excuses the airline if the reroute got you close to your original schedule. If the reroute arrived significantly late, compensation is still due.'
          : '';
      return {
        regulation: REG.UK261,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'GBP' },
        reasoning: `UK261 applies. Notification: ${humanNotification(input.notificationTiming)}. Distance ${distance} km \u2192 \u00a3${tier} tier.${reroutingCaveat}${reasonNote}`,
      };
    }

    case 'denied_boarding': {
      if (input.deniedBoardingType !== 'involuntary') {
        return notApplicable(
          REG.UK261,
          'UK261 covers only involuntary denied boarding.',
        );
      }
      return {
        regulation: REG.UK261,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'GBP' },
        reasoning: `UK261: involuntary denied boarding entitles you to fixed compensation. Distance ${distance} km \u2192 \u00a3${tier}.`,
      };
    }

    case 'downgraded': {
      const pct = downgradePercentage(distance);
      return {
        regulation: REG.UK261,
        applicable: true,
        compensation: {
          type: 'percentage',
          value: pct,
          basis: 'ticket_price',
          currency: 'GBP',
        },
        reasoning: `UK261 Article 10: ${pct}% refund of ticket price for the downgraded segment (distance ${distance} km). No extraordinary-circumstances defense applies.`,
      };
    }

    default:
      return notApplicable(REG.UK261, 'Could not determine — missing issue type.');
  }
}

// ============================================================
// APPR — Canadian Air Passenger Protection Regulations (SOR/2019-150)
// ============================================================
function evaluateAPPR(input) {
  const applies =
    isCanada(input.origin.country) ||
    isCanada(input.destination.country) ||
    isCanada(input.airline.country);

  if (!applies) {
    return notApplicable(
      REG.APPR,
      'APPR (Canada) applies to flights to/from Canada or operated by Canadian-registered carriers. Your flight does not meet any of these conditions.',
    );
  }

  // MVP: treat every Canadian-registered airline as a "large" carrier.
  // Small-carrier amounts are roughly a third of large-carrier amounts.
  const isLargeAirline = isCanada(input.airline.country);
  const ec = extraordinaryCircumstancesAssessment(input.disruptionReason);

  switch (input.issueType) {
    case 'delayed': {
      if (['under_2h', '2_to_3h'].includes(input.delayDuration)) {
        return notApplicable(
          REG.APPR,
          `APPR requires a delay of at least 3 hours at arrival. Your reported delay (${humanDelay(input.delayDuration)}) is below that.`,
        );
      }
      if (ec.exempt === true) {
        return notApplicable(
          REG.APPR,
          `APPR applies, but "${input.disruptionReason}" is typically outside carrier control. ${ec.note}`,
        );
      }
      let amount;
      if (input.delayDuration === '3_to_4h') amount = isLargeAirline ? 400 : 125;
      else if (input.delayDuration === '4h_plus') amount = isLargeAirline ? 700 : 250;
      else amount = isLargeAirline ? 1000 : 500; // never_arrived
      const reasonNote =
        ec.exempt === 'contested' || ec.exempt === 'depends'
          ? ` \u26a0 ${ec.note}`
          : ` ${ec.note}`;
      return {
        regulation: REG.APPR,
        applicable: true,
        compensation: { type: 'fixed', amount, currency: 'CAD' },
        reasoning: `APPR: ${isLargeAirline ? 'large' : 'small'}-carrier delay compensation. Your bucket (${humanDelay(input.delayDuration)}) maps to CAD $${amount} in this MVP. The real APPR amount depends on the exact delay length — contact the airline or a claim service for a precise calculation.${reasonNote}`,
      };
    }

    case 'cancelled': {
      if (input.notificationTiming === '14d_plus') {
        return notApplicable(
          REG.APPR,
          'APPR: no compensation for cancellations notified 14+ days in advance.',
        );
      }
      if (ec.exempt === true) {
        return notApplicable(
          REG.APPR,
          `APPR applies but "${input.disruptionReason}" is typically outside carrier control. ${ec.note}`,
        );
      }
      const amount = isLargeAirline ? 400 : 125;
      const reasonNote =
        ec.exempt === 'contested' || ec.exempt === 'depends'
          ? ` \u26a0 ${ec.note}`
          : ` ${ec.note}`;
      return {
        regulation: REG.APPR,
        applicable: true,
        compensation: { type: 'fixed', amount, currency: 'CAD' },
        reasoning: `APPR: cancellation <14 days before the flight. Base compensation CAD $${amount}. Actual amount scales with the rerouted-arrival delay.${reasonNote}`,
      };
    }

    case 'denied_boarding': {
      if (input.deniedBoardingType !== 'involuntary') {
        return notApplicable(
          REG.APPR,
          'APPR denied-boarding compensation only applies to involuntary bumping.',
        );
      }
      return {
        regulation: REG.APPR,
        applicable: true,
        compensation: { type: 'range', min: 900, max: 2400, currency: 'CAD' },
        reasoning:
          'APPR denied-boarding: CAD $900 for re-accommodation delays under 6h, $1,800 for 6-9h, $2,400 for 9h+. Since we do not have the exact re-accommodation delay, this is the possible range.',
      };
    }

    case 'downgraded':
      return {
        regulation: REG.APPR,
        applicable: true,
        compensation: { type: 'refund_difference', currency: 'CAD' },
        reasoning:
          'APPR requires a refund of the fare difference between the class you booked and the class you actually flew.',
      };

    default:
      return notApplicable(REG.APPR, 'Could not determine — missing issue type.');
  }
}

// ============================================================
// Montreal Convention (1999) — international-flight damages
// ============================================================
function evaluateMontreal(input) {
  const international = input.origin.country !== input.destination.country;
  if (!international) {
    return notApplicable(
      REG.MONTREAL,
      'Montreal Convention applies only to international flights. Yours is domestic.',
    );
  }
  if (!['delayed', 'cancelled'].includes(input.issueType)) {
    return notApplicable(
      REG.MONTREAL,
      'Montreal Convention (as it applies here) covers damages from flight delay or cancellation. Downgrades and denied boarding are handled under the other regulations listed above.',
    );
  }
  return {
    regulation: REG.MONTREAL,
    applicable: true,
    compensation: {
      type: 'actual_damages',
      max: 6303,
      currency: 'SDR',
      approxUSD: 8500,
    },
    reasoning:
      'International flight — the Montreal Convention allows recovery of proven out-of-pocket losses (meals, hotel, missed connections, replacement transport, etc.) up to ~6,303 SDR (~USD $8,500). This is separate from and stacks with any fixed compensation under EU261/UK261/APPR if you incurred real damages.',
  };
}

// ============================================================
// ANAC Resolution 400/2022 — Brazilian passenger rights
// ============================================================
function evaluateANAC(input) {
  const applies =
    isBrazil(input.origin.country) ||
    isBrazil(input.destination.country) ||
    isBrazil(input.airline.country);
  if (!applies) {
    return notApplicable(
      REG.ANAC,
      'ANAC Resolution 400/2022 (Brazil) applies to Brazilian routes or Brazilian carriers. Your flight does not qualify.',
    );
  }
  switch (input.issueType) {
    case 'delayed': {
      if (['under_2h', '2_to_3h'].includes(input.delayDuration)) {
        return {
          regulation: REG.ANAC,
          applicable: true,
          compensation: {
            type: 'assistance_only',
            description: 'meals, communication, possible hotel',
          },
          reasoning:
            'ANAC 400/2022: a 1+ hour delay entitles you to meal vouchers and communication assistance; 2+ hours adds hotel and transport if the delay runs overnight; 4+ hours gives you a choice between refund, rerouting, or travel credit. No fixed cash compensation under ANAC itself.',
        };
      }
      return {
        regulation: REG.ANAC,
        applicable: true,
        compensation: {
          type: 'assistance + court_damages',
          typicalCourt: 'BRL 3000-10000',
        },
        reasoning:
          'ANAC 400/2022 entitles you to assistance (meals, accommodation, rerouting). Separately, Brazilian civil courts have routinely awarded BRL 3,000\u201310,000 per passenger as "dano moral" (moral damages) for delays of this length.',
      };
    }
    case 'cancelled':
      return {
        regulation: REG.ANAC,
        applicable: true,
        compensation: {
          type: 'assistance + court_damages',
          typicalCourt: 'BRL 3000-10000',
        },
        reasoning:
          'ANAC 400/2022 requires the airline to offer a refund, rerouting, or rebooking. Brazilian courts frequently add BRL 3,000\u201310,000 in moral damages on top.',
      };
    case 'denied_boarding':
      if (input.deniedBoardingType !== 'involuntary') {
        return notApplicable(
          REG.ANAC,
          'ANAC denied-boarding compensation only applies to involuntary bumping.',
        );
      }
      return {
        regulation: REG.ANAC,
        applicable: true,
        compensation: { type: 'fixed', amount: 1300, currency: 'BRL' },
        reasoning:
          'ANAC 400/2022: involuntary denied boarding entitles you to auxiliary compensation (~BRL 1,300 for domestic flights; ~BRL 2,600 for international) on top of your original rights (refund, rerouting, or rebooking).',
      };
    case 'downgraded':
      return {
        regulation: REG.ANAC,
        applicable: true,
        compensation: { type: 'refund_difference', currency: 'BRL' },
        reasoning:
          'ANAC requires a refund of the class fare difference for downgrades.',
      };
    default:
      return notApplicable(REG.ANAC, 'Could not determine — missing issue type.');
  }
}

// ============================================================
// Israel Aviation Services Law (ASL), 5772-2012
// ============================================================
function evaluateIsrael(input, distance) {
  const applies =
    isIsrael(input.origin.country) || isIsrael(input.destination.country);
  if (!applies) {
    return notApplicable(
      REG.ISRAEL,
      'Israeli Aviation Services Law applies to flights departing from or arriving in Israel. Your flight does not qualify.',
    );
  }
  const tier = israelTierAmount(distance);
  switch (input.issueType) {
    case 'delayed':
      if (['under_2h', '2_to_3h'].includes(input.delayDuration)) {
        return notApplicable(
          REG.ISRAEL,
          `Israeli ASL requires a delay of at least 3 hours. Your reported delay (${humanDelay(input.delayDuration)}) is below the threshold.`,
        );
      }
      return {
        regulation: REG.ISRAEL,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'ILS' },
        reasoning: `Israeli ASL: arrival delay of 3+ hours. Distance ${distance} km \u2192 ILS ${tier.toLocaleString('en-US')}.`,
      };
    case 'cancelled':
      if (input.notificationTiming === '14d_plus') {
        return notApplicable(
          REG.ISRAEL,
          'Israeli ASL: no compensation for cancellations notified 14+ days in advance.',
        );
      }
      return {
        regulation: REG.ISRAEL,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'ILS' },
        reasoning: `Israeli ASL: cancellation <14 days before the flight. Distance ${distance} km \u2192 ILS ${tier.toLocaleString('en-US')}.`,
      };
    case 'denied_boarding':
      if (input.deniedBoardingType !== 'involuntary') {
        return notApplicable(
          REG.ISRAEL,
          'Israeli ASL denied-boarding compensation only applies to involuntary bumping.',
        );
      }
      return {
        regulation: REG.ISRAEL,
        applicable: true,
        compensation: { type: 'fixed', amount: tier, currency: 'ILS' },
        reasoning: `Israeli ASL: involuntary denied boarding. Distance ${distance} km \u2192 ILS ${tier.toLocaleString('en-US')}.`,
      };
    case 'downgraded':
      return {
        regulation: REG.ISRAEL,
        applicable: true,
        compensation: { type: 'refund_difference', currency: 'ILS' },
        reasoning:
          'Israeli ASL requires refund of the fare difference for downgrades.',
      };
    default:
      return notApplicable(REG.ISRAEL, 'Could not determine — missing issue type.');
  }
}

// ============================================================
// Out-of-scope detection
// Only meaningful when NO regulation above is applicable.
// ============================================================
function outOfScopeAssessment(input) {
  if (input.origin.country !== input.destination.country) {
    return { outOfScope: false, reason: null };
  }
  if (input.origin.country === 'US') {
    return {
      outOfScope: true,
      reason:
        'US domestic flight. The US currently has no fixed-compensation law for delays or cancellations — only refund rights under DOT rules when a flight is cancelled or \u201csignificantly changed.\u201d You can file a DOT complaint at transportation.gov or check your airline\u2019s Customer Service Plan.',
    };
  }
  if (ASIAN_DOMESTIC_CODES.includes(input.origin.country)) {
    return {
      outOfScope: true,
      reason: `Domestic ${input.origin.country} flight. This jurisdiction has no equivalent fixed-compensation law for delays or cancellations. Your rights depend on the airline\u2019s contract of carriage and local consumer-protection rules.`,
    };
  }
  return { outOfScope: false, reason: null };
}

// ---------- Small humanisers (used only inside reasoning strings) ----------
function humanDelay(d) {
  return {
    under_2h: 'under 2 hours',
    '2_to_3h': '2 to under 3 hours',
    '3_to_4h': '3 to under 4 hours',
    '4h_plus': '4 hours or more',
    never_arrived: 'never arrived',
  }[d] ?? 'unknown';
}
function humanNotification(n) {
  return {
    under_7d: 'less than 7 days before',
    '7_to_13d': '7\u201313 days before',
    '14d_plus': '14+ days before',
    at_airport: 'only at the airport',
    unknown: 'unclear',
  }[n] ?? 'unclear';
}

// ============================================================
// Main entry point
// ============================================================
export function evaluateEligibility(input) {
  // Defensive guards — missing data returns an empty-but-shaped result.
  if (
    !input ||
    !input.origin ||
    !input.destination ||
    input.origin.lat == null ||
    input.origin.lon == null ||
    input.destination.lat == null ||
    input.destination.lon == null
  ) {
    return {
      eligible: false,
      distance: 0,
      coverage: [],
      notCoveredBy: [],
      outOfScope: false,
      outOfScopeReason: null,
      notes: ['Missing airport coordinates — cannot compute distance.'],
    };
  }

  const distance = haversineDistance(
    input.origin.lat,
    input.origin.lon,
    input.destination.lat,
    input.destination.lon,
  );

  const intraEu =
    isEUorAssociated(input.origin.country) &&
    isEUorAssociated(input.destination.country);

  const evals = [
    evaluateEU261(input, distance, intraEu),
    evaluateUK261(input, distance),
    evaluateAPPR(input),
    evaluateMontreal(input),
    evaluateANAC(input),
    evaluateIsrael(input, distance),
  ];

  const coverage = evals.filter((e) => e.applicable);
  const notCoveredBy = evals.filter((e) => !e.applicable);
  const eligible = coverage.some((c) => c.compensation !== null);

  // Out-of-scope only fires when NOTHING applies.
  const scopeCheck = outOfScopeAssessment(input);
  const outOfScope = coverage.length === 0 && scopeCheck.outOfScope;

  const notes = [];
  if (intraEu && coverage.some((c) => c.regulation === REG.EU261)) {
    notes.push(
      'Flight is intra-EU/EEA/CH — the EU261 distance tier is capped at \u20ac400 (Article 7(1)).',
    );
  }
  if (coverage.filter((c) => c.compensation?.type === 'fixed').length > 1) {
    notes.push(
      'Multiple regulations propose fixed compensation. You generally cannot stack two fixed amounts from different regimes for the same incident — pick the one most favourable to you. Montreal Convention actual-damages can still be claimed on top if you incurred real out-of-pocket losses.',
    );
  }

  return {
    eligible,
    distance,
    coverage,
    notCoveredBy,
    outOfScope,
    outOfScopeReason: outOfScope ? scopeCheck.reason : null,
    notes,
  };
}
