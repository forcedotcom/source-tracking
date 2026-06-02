# ShadowRepo span baseline

Generated: 2026-05-27T22:50:11.258Z
Source dir: `/Users/shane.mclaughlin/.sf/source-tracking-spans-after`
Files: 11
Total ShadowRepo spans: 124

## Summary

### ShadowRepo.commitChanges

- count: 15
- total: 64826.7 ms
- min / p50 / p90 / p99 / max: 0.3 / 643.6 / 10150.5 / 46910.2 / 46910.2 ms
- worst event-loop block (elMaxMs across all calls): 757.6 ms

#### longest ShadowRepo.commitChanges calls

| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |
| ---------: | -------: | :------ | ------: | -------: | ------: | ------: | ------: | ------: |
|    46910.2 |          |         |         |   200000 |       0 |     1.0 |    27.8 |   757.6 |
|    10150.5 |          |         |         |     2000 |    2000 |     1.1 |     6.4 |   215.9 |
|     2538.1 |          |         |         |     6442 |       0 |     1.0 |    40.0 |   397.7 |
|     1684.5 |          |         |         |     2000 |       0 |     1.0 |    31.9 |   286.8 |
|      741.1 |          |         |         |      208 |       0 |     1.1 |    20.7 |    29.4 |
|      705.2 |          |         |         |      208 |       0 |     1.0 |    22.1 |   129.8 |
|      648.6 |          |         |         |      208 |       0 |     1.1 |    21.2 |    83.2 |
|      643.6 |          |         |         |      208 |       0 |     1.1 |    21.8 |    59.8 |
|      305.1 |          |         |         |        7 |       7 |     1.4 |    15.1 |    21.2 |
|      149.8 |          |         |         |        1 |       1 |     1.0 |     2.6 |     3.9 |

### ShadowRepo.detectMovedFiles

- count: 38
- total: 12702.4 ms
- min / p50 / p90 / p99 / max: 0.3 / 0.6 / 148.2 / 11977.0 / 11977.0 ms
- worst event-loop block (elMaxMs across all calls): 438.8 ms

#### longest ShadowRepo.detectMovedFiles calls

| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |
| ---------: | -------: | :------ | ------: | -------: | ------: | ------: | ------: | ------: |
|    11977.0 |          |         |         |          |    2000 |     1.2 |    10.3 |   438.8 |
|      358.0 |          |         |         |          |       7 |     1.3 |    15.1 |    21.2 |
|      173.4 |          |         |         |          |       1 |     1.0 |     3.9 |     9.2 |
|      148.2 |          |         |         |          |       4 |     1.0 |     5.0 |     9.8 |
|       15.7 |          |         |         |          |       1 |     1.0 |     1.0 |     1.0 |
|       10.9 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        1.7 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        1.3 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        1.0 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        1.0 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |

### ShadowRepo.getStatus

- count: 71
- total: 25274.5 ms
- min / p50 / p90 / p99 / max: 0.2 / 26.5 / 285.5 / 12200.2 / 12200.2 ms
- max rowCount observed: 200,000
- worst event-loop block (elMaxMs across all calls): 2711.6 ms

#### longest ShadowRepo.getStatus calls

| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |
| ---------: | -------: | :------ | ------: | -------: | ------: | ------: | ------: | ------: |
|    12200.2 |     2000 | true    |       1 |          |         |     1.2 |    10.4 |   438.8 |
|     5512.8 |   200000 | false   |       1 |          |         |    17.3 |  2711.6 |  2711.6 |
|     1930.6 |      110 | false   |       1 |          |         |     2.1 |   406.8 |   406.8 |
|     1929.9 |      110 | false   |       1 |          |         |     2.1 |   406.8 |   406.8 |
|      374.8 |     2000 | true    |       1 |          |         |     1.0 |    25.5 |    33.5 |
|      372.5 |        7 | true    |       2 |          |         |     1.2 |    13.1 |    21.2 |
|      308.4 |     2000 | false   |       1 |          |         |     1.4 |    48.0 |    50.5 |
|      285.5 |     6442 | false   |       1 |          |         |     2.2 |   104.1 |   104.1 |
|      275.5 |      208 | true    |       1 |          |         |     1.0 |     9.2 |    16.9 |
|      219.8 |      208 | true    |       2 |          |         |     1.0 |     5.1 |     9.8 |
