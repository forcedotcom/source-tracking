# getStatus / commitChanges — iso vs lite

Generated: 2026-06-02T13:58:05.174Z
Node: v24.14.1
Platform: darwin-arm64
Source: `/Users/shane.mclaughlin/.sf/source-tracking-perf/iso-vs-lite.jsonl`

## Methodology

Two-pass run of the existing perf NUTs ([commitPerf.nut.ts](../../test/nuts/local/commitPerf.nut.ts), [localTrackingScale.nut.ts](../../test/nuts/local/localTrackingScale.nut.ts)) — once with `SF_SOURCE_TRACKING_USE_LITE_GIT=false` (iso), once with `SF_SOURCE_TRACKING_USE_LITE_GIT=true` (lite). Each operation is wrapped in `measure()` ([test/perf-utils/measure.ts](../../test/perf-utils/measure.ts)), capturing wall-clock and a `monitorEventLoopDelay` histogram for the call. Numbers are single-run; this is for ballpark comparison and PR justification, not a statistical baseline.

`getChangedFilenames.cold` is the first call after `getInstance`. The internal `this.status` cache is empty, so this triggers a full status pass on both backends. `getInstance` covers index parse + first switchTo on lite; on iso it includes isomorphic-git's init/open path.

This doc is the baseline the warm UNTR work will be benchmarked against.

### Workload: `200x500`

| op                       | iso wallMs | lite wallMs | iso elP99 | lite elP99 | iso elMax | lite elMax | wall ratio (iso/lite) |
| ------------------------ | ---------: | ----------: | --------: | ---------: | --------: | ---------: | --------------------: |
| getInstance              |        6.3 |        26.0 |       4.5 |        5.2 |       4.5 |        5.2 |                 0.24× |
| getChangedFilenames.cold |     5045.4 |      4007.3 |    2606.8 |        3.4 |    2606.8 |      980.9 |                 1.26× |
| commitChanges            |    44540.2 |     36274.8 |      37.5 |        7.6 |     818.4 |     1184.9 |                 1.23× |

### Workload: `eda`

| op                       | iso wallMs | lite wallMs | iso elP99 | lite elP99 | iso elMax | lite elMax | wall ratio (iso/lite) |
| ------------------------ | ---------: | ----------: | --------: | ---------: | --------: | ---------: | --------------------: |
| getInstance              |        6.8 |        29.6 |       1.0 |        5.5 |       1.0 |        5.5 |                 0.23× |
| getChangedFilenames.cold |      220.7 |       273.7 |     108.5 |       25.1 |     108.5 |       45.0 |                 0.81× |
| commitChanges            |     1972.1 |      1615.9 |      59.3 |       15.3 |     312.2 |       52.2 |                 1.22× |
