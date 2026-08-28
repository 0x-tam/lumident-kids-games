import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { usePlayer } from "./shared/player";

const MIN_AGE = 2;
const MAX_AGE = 14;

/** First-run screen: the child enters their name and sets their age with a +/- toggle. */
export default function Welcome() {
  const { setPlayer } = usePlayer();
  const [name, setName] = useState("");
  const [age, setAge] = useState(6);

  const ready = name.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setPlayer({ name: name.trim(), age });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-6">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 24 }}
        className="neu-surface w-full max-w-[460px] overflow-hidden rounded-[36px]"
      >
        <div className="flex flex-col items-center px-7 pb-2 pt-10 text-center">
          <div
            className="grid h-[112px] w-[112px] place-items-center rounded-[34px]"
            style={{
              background: "linear-gradient(150deg, #F9E2E3, #F2CDCF)",
              boxShadow:
                "inset 3px 4px 6px rgba(255,255,255,0.9), inset -4px -7px 12px rgba(194,30,37,0.12), 0 18px 32px -16px rgba(194,30,37,0.4)",
              animation: "lumi-float 3.6s ease-in-out infinite",
            }}
          >
            <img src="/brand/baby-tooth.webp" alt="" className="h-[92px] w-[92px]" />
          </div>
          <h1 className="mt-[22px] text-[30px] font-extrabold tracking-[-0.01em]">
            Lumident <span className="text-red-deep">Kids</span> Games
          </h1>
          <p className="mt-1.5 text-base font-semibold text-ink-soft">
            Tell us who's playing today
          </p>
        </div>

        <div className="px-8 pb-9 pt-6">
          <label className="block">
            <span className="font-display text-lg font-semibold">What's your name?</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 14))}
              placeholder="Type your name"
              autoFocus
              autoComplete="off"
              enterKeyHint="done"
              aria-label="Your name"
              className="neu-well mt-2.5 w-full rounded-[20px] border-none px-[22px] py-[18px] font-display text-[21px] font-semibold text-ink placeholder:text-ink-mid"
            />
          </label>

          <div className="mt-[26px]">
            <span id="age-label" className="font-display text-lg font-semibold">
              How old are you?
            </span>
            <div
              role="group"
              aria-labelledby="age-label"
              className="mt-3 flex items-center justify-center gap-5"
            >
              <button
                type="button"
                onClick={() => setAge((a) => Math.max(MIN_AGE, a - 1))}
                disabled={age <= MIN_AGE}
                aria-label="One year younger"
                className="neu-raised h-16 w-16 rounded-[22px] text-[30px] font-medium"
              >
                −
              </button>
              <motion.output
                key={age}
                initial={{ scale: 0.8 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 400, damping: 20 }}
                aria-live="polite"
                className="neu-well grid h-20 w-24 place-items-center rounded-[22px] font-display text-[44px] font-semibold"
              >
                {age}
              </motion.output>
              <button
                type="button"
                onClick={() => setAge((a) => Math.min(MAX_AGE, a + 1))}
                disabled={age >= MAX_AGE}
                aria-label="One year older"
                className="neu-raised h-16 w-16 rounded-[22px] text-[30px] font-medium"
              >
                +
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={!ready}
            className="grad-btn grad-red mt-[30px] w-full rounded-3xl py-[19px] text-[21px] tracking-[0.01em]"
          >
            Let's play
          </button>

          <p className="mt-[18px] text-center text-[13.5px] font-semibold text-ink-soft">
            Your high scores are saved on this device.
          </p>
        </div>
      </motion.form>
    </div>
  );
}
