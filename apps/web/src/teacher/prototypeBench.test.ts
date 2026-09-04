/**
 * H.4 `prototype-bench` (§9.4, distributed-vector layer) — the prototype
 * recovers the shared edges above the crosstalk floor and rejects the
 * idiosyncratic ones.
 *
 * §9.4 CAUTION respected: the prime signatures are ADDRESSES, not
 * semantics — synthesis cannot be read off them. The compositional layer
 * is the distributed-vector one: superpose H(member) via the
 * RelationalHologram's own bind/bundle, unbind each role, keep the fillers
 * above the crosstalk floor. For each known hypernym (bird, tool,
 * vehicle), the prototype's recovered edge set must match the hypernym's
 * shared edges exactly, and every idiosyncratic member edge must fall
 * below the floor.
 *
 * Pass: the prototype's recovered edge set matches the hypernym's shared
 * edges. Refute: the prototype cannot separate shared from idiosyncratic.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { RelationalHologram, type RoleFillerPair } from '@sschepis/sentient-core';
import { prototypeBundle } from './conceptSynthesis';

/** Known hypernyms and their members: shared edges (all members) plus one
 *  idiosyncratic edge per member (the noise the prototype must reject). */
const FAMILIES: Record<
  string,
  {
    members: string[];
    shared: RoleFillerPair[];
    idiosyncratic: Record<string, RoleFillerPair>;
  }
> = {
  bird: {
    members: ['robin', 'sparrow', 'crow', 'finch'],
    shared: [
      { predicate: 'has-part', object: 'wings' },
      { predicate: 'has-part', object: 'feathers' },
      { predicate: 'capable-of', object: 'fly' },
      { predicate: 'has-part', object: 'beak' }
    ],
    idiosyncratic: {
      robin: { predicate: 'has-property', object: 'red' },
      sparrow: { predicate: 'has-property', object: 'small' },
      crow: { predicate: 'has-property', object: 'black' },
      finch: { predicate: 'has-property', object: 'yellow' }
    }
  },
  tool: {
    members: ['hammer', 'saw', 'wrench', 'drill'],
    shared: [
      { predicate: 'has-part', object: 'handle' },
      { predicate: 'made-of', object: 'metal' },
      { predicate: 'used-for', object: 'work' }
    ],
    idiosyncratic: {
      hammer: { predicate: 'has-property', object: 'heavy' },
      saw: { predicate: 'has-property', object: 'sharp' },
      wrench: { predicate: 'has-property', object: 'adjustable' },
      drill: { predicate: 'has-property', object: 'electric' }
    }
  },
  vehicle: {
    members: ['car', 'truck', 'bus', 'train'],
    shared: [
      { predicate: 'has-part', object: 'wheels' },
      { predicate: 'has-part', object: 'engine' },
      { predicate: 'capable-of', object: 'move' }
    ],
    idiosyncratic: {
      car: { predicate: 'has-property', object: 'private' },
      truck: { predicate: 'has-property', object: 'cargo' },
      bus: { predicate: 'has-property', object: 'public' },
      train: { predicate: 'has-property', object: 'rail' }
    }
  }
};

const CROSSTALK_FLOOR = 0.35;

describe('H.4 prototype bench: the bundle recovers shared edges and rejects idiosyncratic ones', () => {
  for (const [familyName, family] of Object.entries(FAMILIES)) {
    it(`${familyName}: unbinding the members' bundle recovers exactly the shared edges above the crosstalk floor`, () => {
      const holo = new RelationalHologram({ slots: 128 });
      const edgesOf = (member: string): readonly RoleFillerPair[] => [
        ...family.shared,
        family.idiosyncratic[member]
      ];
      for (const member of family.members) holo.setTrace(member, edgesOf(member));

      const prototype = prototypeBundle(holo, family.members, edgesOf, {
        crosstalkFloor: CROSSTALK_FLOOR
      });

      // RECOVERY: the prototype's significant components are exactly the
      // hypernym's shared edges (role AND filler), above the floor.
      const recovered = new Set(prototype.shared.map((edge) => `${edge.predicate}:${edge.object}`));
      const expected = new Set(family.shared.map((edge) => `${edge.predicate}:${edge.object}`));
      expect(recovered).toEqual(expected);

      // REJECTION: every idiosyncratic member edge sits below the floor.
      for (const member of family.members) {
        const own = family.idiosyncratic[member];
        const rejectedEntry = prototype.rejected.find(
          (edge) => edge.predicate === own.predicate && edge.object === own.object
        );
        expect(rejectedEntry).toBeDefined();
        expect(rejectedEntry!.score).toBeLessThan(CROSSTALK_FLOOR);
      }
      // The separation is real, not marginal: every shared filler scores
      // above the floor with headroom over the best idiosyncratic filler.
      const bestIdio = Math.max(
        ...family.members.map((member) => {
          const own = family.idiosyncratic[member];
          return (
            prototype.rejected.find((edge) => edge.predicate === own.predicate && edge.object === own.object)?.score ??
            0
          );
        })
      );
      const worstShared = Math.min(...prototype.shared.map((edge) => edge.score));
      expect(worstShared).toBeGreaterThan(bestIdio + 0.15);

      // TYPICALITY (§9.4): every member is close to the prototype.
      expect(prototype.typicality.length).toBe(family.members.length);
      for (const entry of prototype.typicality) {
        expect(entry.cosine).toBeGreaterThan(0.8);
      }

      // The entropy reduction is literal: the prototype has FEWER
      // significant components than the sum of its members.
      const totalMemberPairs = family.members.length * (family.shared.length + 1);
      expect(prototype.shared.length).toBeLessThan(totalMemberPairs);
      // eslint-disable-next-line no-console
      console.log(
        `[prototypeBench] ${familyName}: recovered ${prototype.shared.length}/${totalMemberPairs} member pairs ` +
          `(shared ${worstShared.toFixed(3)} vs idiosyncratic ${bestIdio.toFixed(3)})`
      );
    });
  }

  it('a bundle of members with NO shared structure recovers nothing above the floor', () => {
    const holo = new RelationalHologram({ slots: 128 });
    // Realistic disjoint edge sets: each member carries several edges and
    // shares none — everything is crosstalk, nothing clears the floor.
    const members = ['cloud', 'river', 'music', 'shadow'];
    const edges: Record<string, RoleFillerPair[]> = {
      cloud: [
        { predicate: 'located-in', object: 'sky' },
        { predicate: 'made-of', object: 'vapor' },
        { predicate: 'has-property', object: 'white' },
        { predicate: 'capable-of', object: 'rain' },
        { predicate: 'has-property', object: 'fluffy' }
      ],
      river: [
        { predicate: 'made-of', object: 'water' },
        { predicate: 'capable-of', object: 'flow' },
        { predicate: 'located-in', object: 'valley' },
        { predicate: 'has-property', object: 'long' },
        { predicate: 'has-property', object: 'deep' }
      ],
      music: [
        { predicate: 'has-property', object: 'loud' },
        { predicate: 'made-of', object: 'sound' },
        { predicate: 'capable-of', object: 'soothe' },
        { predicate: 'used-for', object: 'dance' },
        { predicate: 'has-property', object: 'sweet' }
      ],
      shadow: [
        { predicate: 'has-property', object: 'dark' },
        { predicate: 'capable-of', object: 'follow' },
        { predicate: 'located-in', object: 'corner' },
        { predicate: 'used-for', object: 'hiding' },
        { predicate: 'has-property', object: 'quiet' }
      ]
    };
    for (const member of members) holo.setTrace(member, edges[member]);
    const prototype = prototypeBundle(holo, members, (member) => edges[member], {
      crosstalkFloor: CROSSTALK_FLOOR
    });
    // Nothing is shared: every filler appears in exactly one member —
    // crosstalk, not signal — and none clears the floor.
    expect(prototype.shared.length).toBe(0);
  });
});
