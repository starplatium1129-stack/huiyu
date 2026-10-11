"""CPU-only scheduler contract, using captured numeric observations, no Comfy dependency."""
import unittest

import torch
from diffusers import FlowMatchEulerDiscreteScheduler

from anima_sampling import call_options, refinement_options, res_call_options


# Complete FP32 results observed through installed Comfy calculate_sigmas(),
# Anima FLOW / shift=3 / multiplier=1 / training table=1000, on 2026-10-11.
# Comfy commit b0b743566f65daafc423b4fea8a2fbda94b3384a. These are output data,
# not sampler source. No Comfy package is required; the implementation uses
# the Apache-2.0 Diffusers scheduler and independent FP32 arithmetic.
NORMAL_REFERENCE = {
    24: [1.0, 0.9851206541061401, 0.9693285822868347, 0.9525370597839355,
         0.9346481561660767, 0.9155507683753967, 0.8951180577278137, 0.8732050061225891,
         0.8496444225311279, 0.8242434859275818, 0.7967777252197266, 0.766984760761261,
         0.7345556020736694, 0.699124276638031, 0.6602535843849182, 0.6174172759056091,
         0.5699757933616638, 0.5171442627906799, 0.4579490125179291, 0.3911662697792053,
         0.31523749232292175, 0.22814567387104034, 0.12723372876644135,
         0.008928571827709675, 0.0],
    30: [1.0, 0.9882712960243225, 0.9759791493415833, 0.9630820155143738,
         0.9495339393615723, 0.9352845549583435, 0.9202777147293091, 0.9044515490531921,
         0.8877370357513428, 0.8700571656227112, 0.8513259887695312, 0.8314467072486877,
         0.8103105425834656, 0.7877941131591797, 0.7637580037117004, 0.7380427718162537,
         0.7104662656784058, 0.6808186769485474, 0.6488576531410217, 0.6143013834953308,
         0.576820433139801, 0.5360270142555237, 0.4914619028568268, 0.44257640838623047,
         0.3887104094028473, 0.3290618658065796, 0.2626469135284424, 0.18824484944343567,
         0.10432276129722595, 0.008928571827709675, 0.0],
}


SGM_REFERENCE = {
    24: [
        1.0, 0.9857583045959473, 0.9706815481185913, 0.9546937942504883,
        0.9377105236053467, 0.9196351170539856, 0.900359034538269, 0.8797585964202881,
        0.8576923608779907, 0.8339980840682983, 0.8084885478019714, 0.7809472680091858,
        0.7511209845542908, 0.7187134027481079, 0.6833740472793579, 0.6446862816810608,
        0.602150559425354, 0.5551626682281494, 0.5029850602149963, 0.4447077214717865,
        0.37919461727142334, 0.3050089478492737, 0.22030651569366455, 0.12268040329217911,
        0.0,
    ],
    30: [
        1.0, 0.9886711835861206, 0.9768170714378357, 0.9644002318382263,
        0.9513797163963318, 0.9377105236053467, 0.9233424663543701, 0.9082211852073669,
        0.8922852277755737, 0.8754674196243286, 0.8576923608779907, 0.8388757109642029,
        0.8189233541488647, 0.7977291941642761, 0.7751736044883728, 0.7511211037635803,
        0.7254173755645752, 0.6978866457939148, 0.668326735496521, 0.6365046501159668,
        0.602150559425354, 0.564949631690979, 0.5245327353477478, 0.48046404123306274,
        0.4322250783443451, 0.3791946768760681, 0.3206214904785156, 0.2555886507034302,
        0.18296529352664948, 0.10134004056453705, 0.0,
    ],
}


class AnimaSamplingTests(unittest.TestCase):
    def test_explicit_grids_match_full_reference_and_execute_exact_step_count(self):
        cases = [(name, steps, values) for name, refs in (("normal", NORMAL_REFERENCE),
                 ("sgm_uniform", SGM_REFERENCE)) for steps, values in refs.items()]
        for name, steps, reference in cases:
            with self.subTest(name=name, steps=steps):
                scheduler = FlowMatchEulerDiscreteScheduler(shift=3.0)
                options = call_options(name, steps, scheduler)
                self.assertEqual(len(options["sigmas"]), steps)
                self.assertGreater(options["sigmas"][-1], 0)
                scheduler.set_timesteps(steps, device="cpu", **options)
                expected = torch.tensor(reference, dtype=torch.float32)
                self.assertTrue(torch.equal(scheduler.sigmas.view(torch.int32), expected.view(torch.int32)))
                self.assertEqual(len(scheduler.timesteps), steps)
                self.assertEqual(scheduler.sigmas[-1].item(), 0.0)
                scheduler.set_begin_index(0)
                sample = torch.ones(1, dtype=torch.float32)
                for timestep in scheduler.timesteps:
                    sample = scheduler.step(torch.ones_like(sample), timestep, sample, return_dict=False)[0]
                self.assertEqual(scheduler.step_index, steps)
        self.assertFalse(torch.cuda.is_initialized())

    def test_simple_keeps_existing_pipeline_options(self):
        self.assertEqual(call_options("simple", 24, object()), {})

    def test_refinement_takes_tail_once_including_both_simple_contracts(self):
        for sampler, name in (("euler", "normal"), ("euler", "simple"), ("res_multistep", "simple")):
            with self.subTest(sampler=sampler, name=name):
                scheduler = FlowMatchEulerDiscreteScheduler(shift=3.0)
                options = refinement_options(name, 12, .5, scheduler, sampler=sampler)
                self.assertEqual(options["num_inference_steps"], 12)
                self.assertEqual(options["strength"], 1.0)
                scheduler.set_timesteps(12, sigmas=options["sigmas"])
                partial = scheduler.sigmas.clone()
                if sampler == "res_multistep":
                    full_options = res_call_options(name, 24, scheduler)
                elif name == "simple":
                    import numpy as np
                    full_options = {"sigmas": np.linspace(1, 1 / 24, 24)}
                else:
                    full_options = call_options(name, 24, scheduler)
                scheduler.set_timesteps(24, **full_options)
                self.assertTrue(torch.equal(partial, scheduler.sigmas[-13:]))
        with self.assertRaises(ValueError):
            refinement_options("normal", 12, 0, scheduler)
        with self.assertRaisesRegex(ValueError, "Unsupported Anima sampler"):
            refinement_options("normal", 12, .5, scheduler, sampler="res_multistep_ancestral")

    def test_explicit_grids_refuse_other_schedule_or_effective_settings(self):
        changes = {"num_train_timesteps": 999, "shift": 2.0,
                   "use_dynamic_shifting": True, "invert_sigmas": True, "shift_terminal": 0.1,
                   "use_karras_sigmas": True, "use_exponential_sigmas": True,
                   "use_beta_sigmas": True, "stochastic_sampling": True}
        for name, key, value in ((name, key, value) for name in ("normal", "sgm_uniform")
                                 for key, value in changes.items()):
            with self.subTest(name=name, key=key):
                scheduler = FlowMatchEulerDiscreteScheduler(shift=3.0)
                scheduler.register_to_config(**{key: value})
                with self.assertRaisesRegex(ValueError, key):
                    call_options(name, 24, scheduler)
        scheduler = FlowMatchEulerDiscreteScheduler(shift=3.0)
        scheduler.set_shift(2.0)
        with self.assertRaisesRegex(ValueError, "effective scheduler shift"):
            call_options("normal", 24, scheduler)
        with self.assertRaisesRegex(ValueError, "Unsupported Anima scheduler"):
            call_options("unknown", 24, scheduler)


if __name__ == "__main__":
    unittest.main()
