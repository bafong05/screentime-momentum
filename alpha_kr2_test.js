const INACTIVITY_THRESHOLD_MS = 15 * 60 * 1000;

function groupIntoSessions(visits) {
  if (!visits.length) return [];

  const sorted = [...visits].sort((a, b) => a.time - b.time);

  const sessions = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.time - prev.time;

    if (gap > INACTIVITY_THRESHOLD_MS) {
      sessions.push(current);
      current = [];
    }

    current.push(curr);
  }

  sessions.push(current);

  return sessions;
}

const results = [];

function runGroupingTest(name, visits, expectedSessions) {
  const sessions = groupIntoSessions(visits);
  const actualSessions = sessions.length;

  results.push({
    test: name,
    expectedSessions,
    actualSessions,
    result: expectedSessions === actualSessions ? "PASS" : "FAIL"
  });
}

runGroupingTest(
  "Empty visits",
  [],
  0
);

runGroupingTest(
  "Single visit",
  [
    { domain: "google.com", time: 0 }
  ],
  1
);

runGroupingTest(
  "Two visits within threshold",
  [
    { domain: "google.com", time: 0 },
    { domain: "youtube.com", time: 10000 }
  ],
  1
);

runGroupingTest(
  "Two visits beyond threshold",
  [
    { domain: "google.com", time: 0 },
    { domain: "youtube.com", time: 910000 }
  ],
  2
);

runGroupingTest(
  "Exactly 15 minutes apart",
  [
    { domain: "google.com", time: 0 },
    { domain: "youtube.com", time: 900000 }
  ],
  1
);

runGroupingTest(
  "Three visits, last starts new session",
  [
    { domain: "a.com", time: 0 },
    { domain: "b.com", time: 20000 },
    { domain: "c.com", time: 910000 }
  ],
  1
);

runGroupingTest(
  "Multiple session splits",
  [
    { domain: "a.com", time: 0 },
    { domain: "b.com", time: 10000 },
    { domain: "c.com", time: 910000 },
    { domain: "d.com", time: 920000 },
    { domain: "e.com", time: 2000000 }
  ],
  2
);

runGroupingTest(
  "Repeated domains grouped by time",
  [
    { domain: "google.com", time: 0 },
    { domain: "google.com", time: 20000 },
    { domain: "google.com", time: 910000 }
  ],
  1
);

runGroupingTest(
  "Out of order visits sorted correctly",
  [
    { domain: "b.com", time: 20000 },
    { domain: "a.com", time: 0 },
    { domain: "c.com", time: 910000 }
  ],
  1
);

runGroupingTest(
  "Realistic browsing pattern",
  [
    { domain: "docs.google.com", time: 0 },
    { domain: "slack.com", time: 3000 },
    { domain: "figma.com", time: 10000 },
    { domain: "gmail.com", time: 920000 },
    { domain: "calendar.google.com", time: 930000 }
  ],
  2
);

console.table(results);

const allPassed = results.every(r => r.result === "PASS");

if (allPassed) {
  console.log("All KR2 session grouping tests passed.");
} else {
  console.log("Some KR2 tests failed.");
}