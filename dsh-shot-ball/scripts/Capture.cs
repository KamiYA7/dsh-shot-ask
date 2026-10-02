// dsh-shot-capture — one rectangle of the desktop to a PNG, with no PowerShell.
//
// Why this exists: the ball's shutter ran through `powershell.exe`, and measured
// startup alone is 1130 ms on this machine — most of the click-to-capture time.
// A tiny compiled executable starts in tens of milliseconds, so the shutter cost
// drops to roughly the cost of the pixels. The ball compiles this once into a
// cached .exe next to itself and reuses it.
//
// Usage:
//   dsh-shot-capture.exe <x> <y> <width> <height> <output.png>
//
// Output on success: "OK <path> <width>x<height>"; on failure: "ERR <message>"
// and a non-zero exit code.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

internal static class Program
{
    // Per-monitor-v2 DPI awareness. Without it a scaled desktop reports and
    // captures logical pixels, and the requested rectangle would be wrong by the
    // scale factor. -4 is DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private static void EnableDpiAwareness()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 5)
            {
                Console.Error.WriteLine("ERR usage: dsh-shot-capture <x> <y> <width> <height> <output.png>");
                return 2;
            }

            int x = int.Parse(args[0]);
            int y = int.Parse(args[1]);
            int width = int.Parse(args[2]);
            int height = int.Parse(args[3]);
            string output = args[4];

            EnableDpiAwareness();

            if (width < 1 || height < 1)
            {
                Console.Error.WriteLine("ERR refusing a " + width + "x" + height + " region");
                return 3;
            }

            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(
                        x, y, 0, 0,
                        new Size(width, height),
                        CopyPixelOperation.SourceCopy);
                }

                string directory = System.IO.Path.GetDirectoryName(output);
                if (!string.IsNullOrEmpty(directory) && !System.IO.Directory.Exists(directory))
                {
                    System.IO.Directory.CreateDirectory(directory);
                }
                bitmap.Save(output, ImageFormat.Png);
            }

            Console.Out.WriteLine("OK " + output + " " + width + "x" + height);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("ERR " + error.Message);
            return 1;
        }
    }
}
