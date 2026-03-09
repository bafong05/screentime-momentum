function computeSessionMetrics(visits) {
  if (!visits.length) return null;

  const start = visits[0].time;
  const end = visits[visits.length - 1].time;
  const durationMs = Math.max(0, end - start);

  const domains = visits.map((v) => v.domain);
  const uniqueDomains = Array.from(new Set(domains));

  const timePerDomain = {};
  for (let i = 0; i < visits.length; i++) {
    const curr = visits[i];
    const next = visits[i + 1];
    const dt = next ? Math.max(0, next.time - curr.time) : 0;
    timePerDomain[curr.domain] = (timePerDomain[curr.domain] || 0) + dt;
  }

  return {
    durationMs,
    totalSites: uniqueDomains.length,
    timePerDomain
  };
}

const results = [];

function runMetricTest(name, visits, expected) {
  const actual = computeSessionMetrics(visits);

  const durationPass = actual.durationMs === expected.durationMs;
  const sitesPass = actual.totalSites === expected.totalSites;
  const timePerDomainPass =
    JSON.stringify(actual.timePerDomain) === JSON.stringify(expected.timePerDomain);

  results.push({
    test: name,
    duration: `${actual.durationMs}/${expected.durationMs}`,
    sites: `${actual.totalSites}/${expected.totalSites}`,
    timePerSite: timePerDomainPass ? "MATCH" : "MISMATCH",
    result: durationPass && sitesPass && timePerDomainPass ? "PASS" : "FAIL"
  });
}

runMetricTest(
  "Single visit",
  [
    { domain: "wikipedia.org", time: 1000 }
  ],
  {
    durationMs: 0,
    totalSites: 1,
    timePerDomain: {
      "wikipedia.org": 0
    }
  }
);

runMetricTest(
  "2 visits, different sites",
  [
    { domain: "wikipedia.org", time: 0 },
    { domain: "cnn.com", time: 10000 }
  ],
  {
    durationMs: 10000,
    totalSites: 2,
    timePerDomain: {
      "wikipedia.org": 10000,
      "cnn.com": 0
    }
  }
);

runMetricTest(
  "3 visits, 3 sites",
  [
    { domain: "wikipedia.org", time: 0 },
    { domain: "cnn.com", time: 10000 },
    { domain: "nytimes.com", time: 15000 }
  ],
  {
    durationMs: 15000,
    totalSites: 3,
    timePerDomain: {
      "wikipedia.org": 10000,
      "cnn.com": 5000,
      "nytimes.com": 0
    }
  }
);

runMetricTest(
  "Repeated same site",
  [
    { domain: "youtube.com", time: 0 },
    { domain: "youtube.com", time: 5000 },
    { domain: "youtube.com", time: 12000 }
  ],
  {
    durationMs: 12000,
    totalSites: 1,
    timePerDomain: {
      "youtube.com": 12000
    }
  }
);

runMetricTest(
  "Mixed repeated sites",
  [
    { domain: "google.com", time: 0 },
    { domain: "youtube.com", time: 4000 },
    { domain: "google.com", time: 10000 },
    { domain: "reddit.com", time: 15000 }
  ],
  {
    durationMs: 15000,
    totalSites: 3,
    timePerDomain: {
      "google.com": 9000,
      "youtube.com": 6000,
      "reddit.com": 0
    }
  }
);

runMetricTest(
  "Zero gap between first two visits",
  [
    { domain: "google.com", time: 0 },
    { domain: "youtube.com", time: 0 },
    { domain: "reddit.com", time: 5000 }
  ],
  {
    durationMs: 5000,
    totalSites: 3,
    timePerDomain: {
      "google.com": 0,
      "youtube.com": 5000,
      "reddit.com": 0
    }
  }
);

runMetricTest(
  "4 visits, 2 unique sites",
  [
    { domain: "gmail.com", time: 0 },
    { domain: "docs.google.com", time: 3000 },
    { domain: "gmail.com", time: 7000 },
    { domain: "docs.google.com", time: 10000 }
  ],
  {
    durationMs: 10000,
    totalSites: 2,
    timePerDomain: {
      "gmail.com": 6000,
      "docs.google.com": 4000
    }
  }
);

runMetricTest(
  "Realistic work session",
  [
    { domain: "docs.google.com", time: 0 },
    { domain: "slack.com", time: 3000 },
    { domain: "docs.google.com", time: 8000 },
    { domain: "figma.com", time: 15000 },
    { domain: "docs.google.com", time: 21000 },
    { domain: "gmail.com", time: 30000 }
  ],
  {
    durationMs: 30000,
    totalSites: 4,
    timePerDomain: {
      "docs.google.com": 19000,
      "slack.com": 5000,
      "figma.com": 6000,
      "gmail.com": 0
    }
  }
);

runMetricTest(
  "Last site gets zero time",
  [
    { domain: "a.com", time: 0 },
    { domain: "b.com", time: 2000 },
    { domain: "c.com", time: 7000 },
    { domain: "d.com", time: 9000 }
  ],
  {
    durationMs: 9000,
    totalSites: 4,
    timePerDomain: {
      "a.com": 2000,
      "b.com": 5000,
      "c.com": 2000,
      "d.com": 0
    }
  }
);

runMetricTest(
  "Alternating two sites",
  [
    { domain: "a.com", time: 0 },
    { domain: "b.com", time: 3000 },
    { domain: "a.com", time: 8000 },
    { domain: "b.com", time: 12000 }
  ],
  {
    durationMs: 12000,
    totalSites: 2,
    timePerDomain: {
      "a.com": 7000,
      "b.com": 5000
    }
  }
);

console.table(results);

const allPassed = results.every((r) => r.result === "PASS");

if (allPassed) {
  console.log("All KR3 metric tests passed.");
} else {
  console.log("Some KR3 metric tests failed.");
}