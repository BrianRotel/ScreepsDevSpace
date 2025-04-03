// Any modules that you use that modify the game's prototypes should be require'd
// before you require the profiler.
import profiler from './3rd/screeps-profiler'
import {errorMapper} from './modules/errorMapper'
import {cleanMemory, sayHello, visualizeTerrain} from './modules/utils'
import {CalculateLayout} from './3rd/JS_Layout/build_Layout_v1.1'
import autoPlan from './3rd/JS_Layout/63_good'

function funcCalculateLayout() {
    let center = Game.flags.center; // 房间中心的位置
    let pa = Game.flags.pa;
    let pb = Game.flags.pb;
    let pc = Game.flags.pc;
    let pm = Game.flags.pm;
    if (center) {
        let points = [pc.pos, pm.pos, pa.pos]
        if (pb) points.push(pb.pos)
        CalculateLayout(center.pos, points)
    }
}
function funcShowInfo() {
    //console.log(`当前 CPU 上限: ${Game.cpu.limit} ms/tick`);
    // 正确获取地形对象（注意房间名称格式）
    //visualizeTerrain("W8N3");
    sayHello()
}

// This line monkey patches the global prototypes.
profiler.enable();
module.exports.loop = errorMapper(() => {
    profiler.wrap(function () {
        const startCpu = Game.cpu.getUsed(); // 记录开始时间
        //console.log(`startCpu : ${startCpu} ms`);
        autoPlan.run()
        funcCalculateLayout()
        const endCpu = Game.cpu.getUsed(); // 记录结束时间
        //console.log(`endCpu : ${endCpu} ms`);
        console.log(`CPU 消耗: ${(endCpu - startCpu).toFixed(2)} ms`);
        funcShowInfo()
    });
})
