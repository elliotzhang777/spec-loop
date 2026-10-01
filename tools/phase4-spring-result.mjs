export function springT2Passed({exitCode,tests,failures,errors,initialStatus,finalStatus,initialHead,finalHead}){
  return exitCode===0&&tests===2&&failures===0&&errors===0&&initialStatus===''&&finalStatus===''&&initialHead===finalHead
}
