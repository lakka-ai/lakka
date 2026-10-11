#!/usr/bin/env bash
# Routing on non-English text (NF-A3, ADR 0088): the bundled classifier, offline on the reference
# hardware, on the translations of the evaluation set, first with each route's examples in the
# same language, then with the English examples. Each must reach 75% accuracy; English itself
# is held to 80% by the step before.
#
# Then the description fallback (RT-12, ADR 0122) in all five languages, English included: with
# each route in turn described and the others trained, for every blind description set, no lower
# accuracy and no more misroutes than without the fallback. And the description among a route's
# examples (ADR 0125): no lower accuracy and no more misroutes than the examples alone, for a new
# route with 1, 2 and 4 examples and with every route described at 12. The new route at 12 is
# printed but not held to it.
#
# With a model directory under /app/models, the same for that model (ADR 0123): mpnet is held to
# 78% in the other languages, and the default model to 75%.
#
#   scripts/classifier-eval-languages.sh <app image> [model] [min accuracy]
set -euo pipefail
image=${1:?app image}
model=${2:-}
min=${3:-0.75}
eval_dir=/app/packages/core/eval
env=()
[ -z "$model" ] || env=(-e "LAKKA_CLASSIFIER_MODEL_DIR=/app/models/$model")
name=${model:-the default model}
for lang in de fr es sv; do
  for examples in same english; do
    args=(--set "$eval_dir/routing-v1.$lang.json" --min-accuracy "$min")
    [ "$examples" = same ] || args+=(--examples-from "$eval_dir/routing-v1.json")
    result=$(docker run --rm --network none --cpus 2 ${env[@]+"${env[@]}"} "$image" classifier-eval "${args[@]}")
    accuracy=$(printf '%s' "$result" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).defaults.result.accuracy; console.log((a.mean*100).toFixed(1)+' +/- '+(a.std*100).toFixed(1))})")
    echo "classifier-eval: $name, $lang, $examples examples: $accuracy"
  done
done
for lang in en de fr es sv; do
  args=(--fallback)
  [ "$lang" = en ] || args+=(--set "$eval_dir/routing-v1.$lang.json")
  status=0
  result=$(docker run --rm --network none --cpus 2 ${env[@]+"${env[@]}"} "$image" classifier-eval "${args[@]}") || status=$?
  printf '%s' "$result" | MODEL_NAME="$name" LANG_CODE="$lang" node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s).fallback;const p=(x)=>(x*100).toFixed(1);for(const [name,r] of Object.entries(f.sets)){console.log('classifier-eval: '+process.env.MODEL_NAME+', '+process.env.LANG_CODE+', fallback, '+name+': today '+p(r.today.accuracy.mean)+' (misroutes '+p(r.today.misrouteRate.mean)+'), with the fallback '+p(r.fallback.accuracy.mean)+' (misroutes '+p(r.fallback.misrouteRate.mean)+'), new route recall '+p(r.newRouteRecall.fallback.mean)+(r.ok?'':', WORSE'))}})"
  printf '%s' "$result" | MODEL_NAME="$name" LANG_CODE="$lang" node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s).fallback.blend;const p=(x)=>(x*100).toFixed(1);for(const [set,cases] of Object.entries(b)){for(const [name,c] of Object.entries(cases)){console.log('classifier-eval: '+process.env.MODEL_NAME+', '+process.env.LANG_CODE+', blend, '+set+', '+name+': examples '+p(c.examples.accuracy.mean)+' (misroutes '+p(c.examples.misrouteRate.mean)+'), with the description '+p(c.with_description.accuracy.mean)+' (misroutes '+p(c.with_description.misrouteRate.mean)+')'+(c.ok?'':(c.gated?', WORSE':', worse, not gated')))}}})"
  if [ "$status" -ne 0 ]; then
    verdicts=$(printf '%s' "$result" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s).fallback;console.log((f.ok?'':'fallback ')+(f.blend_ok?'':'blend'))})")
    case "$verdicts" in
      *fallback*) echo "classifier-eval: $name, $lang, the description fallback did worse than no fallback" >&2 ;;
    esac
    case "$verdicts" in
      *blend*) echo "classifier-eval: $name, $lang, the description among the examples did worse than the examples alone" >&2 ;;
    esac
    exit 1
  fi
done
