const MIN_PARALLEL_WORKERS: u32 = 2;
const PROBE_COOLDOWN: u8 = 3;
const MIN_PROBE_GAIN: f64 = 1.08;

struct Probe {
    baseline: f64,
    first_rate: Option<f64>,
}

pub(super) struct WorkerTuner {
    target: u32,
    ceiling: u32,
    baseline: Option<f64>,
    probe: Option<Probe>,
    cooldown: u8,
}

impl WorkerTuner {
    pub(super) fn new(ceiling: u32, adaptive: bool) -> Self {
        Self {
            target: if adaptive {
                ceiling.min(MIN_PARALLEL_WORKERS)
            } else {
                ceiling
            },
            ceiling,
            baseline: None,
            probe: None,
            cooldown: 0,
        }
    }

    pub(super) fn target(&self) -> u32 {
        self.target
    }

    pub(super) fn sample(&mut self, rate: f64) -> u32 {
        if rate <= 0.0 {
            return self.target;
        }

        if let Some(mut probe) = self.probe.take() {
            if let Some(first_rate) = probe.first_rate {
                if (first_rate + rate) / 2.0 < probe.baseline * MIN_PROBE_GAIN {
                    // Only undo a worker added by a probe. A slow interval
                    // at the baseline cannot cut the initial parallelism.
                    self.target -= 1;
                    self.cooldown = PROBE_COOLDOWN;
                }
            } else {
                probe.first_rate = Some(rate);
                self.probe = Some(probe);
            }
            return self.target;
        }

        let previous_rate = self.baseline.replace(rate);
        if self.cooldown > 0 {
            self.cooldown -= 1;
        } else if let Some(previous_rate) = previous_rate.filter(|_| self.target < self.ceiling) {
            self.target += 1;
            self.baseline = None;
            self.probe = Some(Probe {
                baseline: (previous_rate + rate) / 2.0,
                first_rate: None,
            });
        }
        self.target
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_rates_and_dips_keep_two_workers() {
        let mut tuner = WorkerTuner::new(8, true);
        assert_eq!(tuner.target(), 2);
        for rate in [100.0, 100.0, 20.0, 100.0].into_iter().cycle().take(40) {
            assert!(tuner.sample(rate) >= 2);
        }
    }

    #[test]
    fn rejects_a_probe_then_retries_and_keeps_it_when_it_helps() {
        let mut tuner = WorkerTuner::new(3, true);
        for (rate, target) in [
            (100.0, 2),
            (100.0, 3),
            (0.0, 3),
            (100.0, 3),
            (100.0, 2),
            (100.0, 2),
            (100.0, 2),
            (100.0, 2),
            (100.0, 3),
            (125.0, 3),
            (125.0, 3),
            (125.0, 3),
        ] {
            assert_eq!(tuner.sample(rate), target);
        }
    }

    #[test]
    fn respects_fixed_and_small_download_limits() {
        assert_eq!(WorkerTuner::new(8, false).target(), 8);
        for ceiling in [0, 1, 2] {
            let mut tuner = WorkerTuner::new(ceiling, true);
            assert_eq!(tuner.target(), ceiling);
            assert_eq!(tuner.sample(100.0), ceiling);
            assert_eq!(tuner.sample(200.0), ceiling);
        }
    }
}
