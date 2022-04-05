const height = 70;    // number of rows  /     default: 50
const width = 50;   // number of columns      default: 100
let fire = new Array(width * height).fill(0); // declare and reset the array that holds the value of all the tiles

let context = document.getElementById('myCanvas').getContext('2d');
window.requestAnimationFrame(burn);

function burn() {
  for (let i = 0; i < width; i++)
    fire[i + width] = Math.random() * 255; // randomize the 2nd row from the bottom

  for (let y = height; y > 1; y--)           // every row
    for (let x = 0; x < width; x++) {  // every column
      let i = y * width + x;   // convert the x and y coordinates to the array index
      fire[i] = Math.floor((                // add the cell values:
        fire[(y - 1) * width + (x - 2 + width) % width] +     // below, left
        fire[(y - 1) * width + (x + width) % width] +     // immediately below
        fire[(y - 1) * width + (x + 1 + width) % width] +        // below, right
        fire[(y - 2) * width + (x + width) % width]        // two rows below
      ) / 4.01);
    }                        // division to lower the value as the fire goes up

  for (let i = width * 7; i < width * height; i++) {        // now we're drawing the fire on the screen
    context.beginPath();        // convert the index value i to screen coordinates and draw a box
    context.rect((i % width) * 10, (height - Math.floor(i / width)) * 10, 10, 10);
    context.fillStyle = 'rgb(' + fire[i] + ',0,0)'; // the red component of the RGB color is the value of the cell.
    //context.fillStyle ='rgb(' + fire[i]+ fire[i]+ ',0)';
    context.fill();
  }
  const arson = () => window.requestAnimationFrame(burn);
  arson();
  // setInterval(arson, 50)
}