/**
 * Standalone view of the hero section, without the rest of the homepage around
 * it. Useful for judging the animation on its own.
 */
import {HeroDroneStage} from '~/components/HeroDroneStage';

export default function HeroPreview() {
  return (
    <main className="hp">
      <HeroDroneStage />
      <section className="hp-after">
        <p>Page continues here. The hero releases the scroll once the sequence ends.</p>
      </section>
    </main>
  );
}
