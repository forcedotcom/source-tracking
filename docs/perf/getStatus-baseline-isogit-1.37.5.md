# ShadowRepo span baseline

Generated: 2026-05-27T22:35:58.288Z
Source dir: `/Users/shane.mclaughlin/.sf/source-tracking-spans-baseline`
Files: 10
Total ShadowRepo spans: 124

## Summary

### ShadowRepo.commitChanges

- count: 15
- total: 68272.6 ms
- min / p50 / p90 / p99 / max: 0.3 / 598.4 / 14994.1 / 45696.3 / 45696.3 ms
- worst event-loop block (elMaxMs across all calls): 769.7 ms

#### longest ShadowRepo.commitChanges calls

| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |
| ---------: | -------: | :------ | ------: | -------: | ------: | ------: | ------: | ------: |
|    45696.3 |          |         |         |   200000 |       0 |     1.0 |    24.5 |   769.7 |
|    14994.1 |          |         |         |     2000 |    2000 |     1.1 |     9.5 |   172.2 |
|     2885.3 |          |         |         |     6442 |       0 |     1.0 |    17.4 |   450.9 |
|     1190.8 |          |         |         |     2000 |       0 |     1.0 |    44.7 |   170.7 |
|      660.0 |          |         |         |      208 |       0 |     1.1 |    21.3 |    67.2 |
|      643.5 |          |         |         |      208 |       0 |     1.1 |    17.9 |    94.4 |
|      628.9 |          |         |         |      208 |       0 |     1.0 |    16.4 |   112.1 |
|      598.4 |          |         |         |      208 |       0 |     1.0 |    24.0 |   106.6 |
|      312.8 |          |         |         |        7 |       0 |     1.7 |    20.4 |    38.2 |
|      206.9 |          |         |         |        3 |       4 |     1.0 |     5.3 |     7.5 |

### ShadowRepo.detectMovedFiles

- count: 38
- total: 17378.1 ms
- min / p50 / p90 / p99 / max: 0.3 / 0.6 / 166.0 / 16685.2 / 16685.2 ms
- worst event-loop block (elMaxMs across all calls): 498.9 ms

#### longest ShadowRepo.detectMovedFiles calls

| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |
| ---------: | -------: | :------ | ------: | -------: | ------: | ------: | ------: | ------: |
|    16685.2 |          |         |         |          |    2000 |     1.1 |    11.2 |   498.9 |
|      241.4 |          |         |         |          |       1 |     1.0 |     7.9 |    15.6 |
|      238.0 |          |         |         |          |       4 |     1.0 |     6.6 |     9.6 |
|      166.0 |          |         |         |          |       7 |     1.0 |     6.0 |     6.0 |
|       15.8 |          |         |         |          |       1 |     1.0 |     1.1 |     1.1 |
|        9.9 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        3.4 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        2.1 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        1.3 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |
|        1.0 |          |         |         |          |       0 |     0.0 |     0.0 |     0.0 |

### ShadowRepo.getStatus

- count: 71
- total: 30229.9 ms
- min / p50 / p90 / p99 / max: 0.2 / 12.7 / 303.6 / 16809.3 / 16809.3 ms
- max rowCount observed: 200,000
- worst event-loop block (elMaxMs across all calls): 2587.9 ms

#### longest ShadowRepo.getStatus calls

| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |
| ---------: | -------: | :------ | ------: | -------: | ------: | ------: | ------: | ------: |
|    16809.3 |     2000 | true    |       1 |          |         |     1.1 |    11.6 |   498.9 |
|     5046.2 |   200000 | false   |       1 |          |         |     1.6 |  2587.9 |  2587.9 |
|     2029.1 |      110 | false   |       1 |          |         |     1.1 |   354.4 |   354.4 |
|     2027.7 |      110 | false   |       1 |          |         |     1.1 |   354.4 |   354.4 |
|      418.9 |     6442 | false   |       1 |          |         |     1.7 |   151.1 |   151.1 |
|      393.8 |      208 | true    |       1 |          |         |     1.0 |     8.6 |    17.8 |
|      343.5 |     2000 | true    |       1 |          |         |     1.0 |    23.5 |    44.7 |
|      303.6 |      208 | true    |       2 |          |         |     1.0 |     6.6 |     9.6 |
|      303.0 |     2000 | false   |       1 |          |         |     1.5 |   106.5 |   106.5 |
|      290.2 |     2000 | true    |       1 |          |         |     1.0 |    12.8 |    30.7 |
