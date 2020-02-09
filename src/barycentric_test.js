document.addEventListener("DOMContentLoaded", function(event) {

    const canvas = document.querySelector("#main-canvas");
    const context = canvas.getContext("2d");

    let tri = new Triangle(Array(3).fill(0).map(x => Vec.of(...Vec.random(2, 25, 300), 0)));

    let drawData = [
        [1, 2, "rgba(  0, 255,   0, 0.5)", 'green',  'a'],
        [0, 2, "rgba(  0,   0, 255, 0.5)", 'blue', 'b'],
        [0, 1, "rgba(255,   0,   0, 0.5)", 'red',   'c']
    ];

    drawTriangle(tri.ps);
    labelTriangle(tri.ps);
    document.querySelector("#vertex-positions").innerHTML = "Vertex Positions: " + tri.ps.toString();

    const compute_mouse_position = function( e, rect = canvas.getBoundingClientRect() ) {
        return Vec.of(
            e.clientX - rect.left,
            e.clientY - rect.top);
    };

    canvas.addEventListener("mousemove", e => {
        e.preventDefault();

        const mouse_pos = compute_mouse_position(e);
        const bary = tri.toBarycentric(mouse_pos);
        const blended = Triangle.blend(bary, tri.ps);

        document.querySelector("#mouse-position").innerHTML = "Mouse position: " + mouse_pos.toString();
        document.querySelector("#bary-weights").innerHTML = "Barycentric weights: " + bary.toString();
        document.querySelector("#bary-blended").innerHTML =
            "Blended position from barycentric weights: " + blended.toString();


        context.clearRect(0, 0, canvas.width, canvas.height);

        for (let i of [0,1,2].sort((x,y) => bary[y] - bary[x]))
            drawTriangle([tri.ps[drawData[i][0]], tri.ps[drawData[i][1]], mouse_pos], drawData[i][2]);
        for (let i of [0,1,2])
            drawTriangle([tri.ps[drawData[i][0]], tri.ps[drawData[i][1]], mouse_pos]);


        drawTriangle(tri.ps);
        labelTriangle(tri.ps);

        drawPoint(mouse_pos);
        drawPoint(blended, "yellow")
    });

    function drawTriangle(ps, fill="") {
        context.beginPath();
        context.moveTo(ps[2][0], ps[2][1]);
        for (let i = 0; i < 3; ++i)
            context.lineTo(ps[i][0], ps[i][1]);
        if (fill) {
            context.fillStyle = fill;
            context.fill();
        }
        else {
            context.lineWidth = 2;
            context.lineCap = "round";
            context.lineJoin = "round";
            context.stroke();
        }
    }

    function labelTriangle(ps) {
        context.font = '48px serif';
        context.lineWidth = 1;
        for (let i = 0; i < 3; ++i) {
            context.fillStyle = drawData[i][3];
            context.fillText(drawData[i][4], ps[i][0], ps[i][1]);
            context.strokeText(drawData[i][4], ps[i][0], ps[i][1]);
        }
    }

    function drawPoint(pos, color="black", radius=5) {
        context.beginPath();
        context.arc(pos[0], pos[1], radius, 0, 2 * Math.PI, false);
        context.fillStyle = color;
        context.fill();
    }
});