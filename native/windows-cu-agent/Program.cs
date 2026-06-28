using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

static class WinApi {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, nuint extraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int xDest, int yDest, int width, int height, IntPtr source, int xSource, int ySource, uint operation);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateDC(string driver, string? device, string? output, IntPtr initData);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

  public const uint LeftDown = 0x0002, LeftUp = 0x0004, RightDown = 0x0008, RightUp = 0x0010;
  public const uint Move = 0x0001, Wheel = 0x0800, Copy = 0x00CC0020;
  public const int Restore = 9;
  public struct Rect { public int Left, Top, Right, Bottom; }
}

static class Program {
static byte[] Screenshot() {
  IntPtr screen = WinApi.CreateDC("DISPLAY", null, null, IntPtr.Zero);
  IntPtr memory = WinApi.CreateCompatibleDC(screen);
  int width = WinApi.GetSystemMetrics(0), height = WinApi.GetSystemMetrics(1);
  IntPtr bitmap = WinApi.CreateCompatibleBitmap(screen, width, height);
  IntPtr previous = WinApi.SelectObject(memory, bitmap);
  try {
    WinApi.BitBlt(memory, 0, 0, width, height, screen, 0, 0, WinApi.Copy);
    using Bitmap image = Image.FromHbitmap(bitmap);
    using MemoryStream stream = new();
    image.Save(stream, ImageFormat.Png);
    return stream.ToArray();
  } finally {
    WinApi.SelectObject(memory, previous);
    WinApi.DeleteObject(bitmap);
    WinApi.DeleteDC(memory);
    WinApi.DeleteDC(screen);
  }
}

static int Int(Dictionary<string, JsonElement> command, string key, int fallback = 0) =>
  command.TryGetValue(key, out var value) ? value.GetInt32() : fallback;

static string Text(Dictionary<string, JsonElement> command, string key, string fallback = "") =>
  command.TryGetValue(key, out var value) ? value.GetString() ?? fallback : fallback;

static void MouseButton(string button, bool down) {
  uint flag = button == "right"
    ? (down ? WinApi.RightDown : WinApi.RightUp)
    : (down ? WinApi.LeftDown : WinApi.LeftUp);
  WinApi.mouse_event(flag, 0, 0, 0, 0);
}

static string SendKeyName(string key) {
  var names = new Dictionary<string, string> {
    ["return"] = "{ENTER}", ["enter"] = "{ENTER}", ["tab"] = "{TAB}",
    ["escape"] = "{ESC}", ["esc"] = "{ESC}", ["space"] = " ",
    ["backspace"] = "{BACKSPACE}", ["delete"] = "{DELETE}",
    ["up"] = "{UP}", ["down"] = "{DOWN}", ["left"] = "{LEFT}", ["right"] = "{RIGHT}",
    ["home"] = "{HOME}", ["end"] = "{END}", ["page_up"] = "{PGUP}", ["page_down"] = "{PGDN}"
  };
  return names.GetValueOrDefault(key, key);
}

public static void Main() {
string? line;
while ((line = Console.ReadLine()) != null) {
  try {
    var command = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(line);
    if (command == null) continue;
    string action = Text(command, "action");
    var result = new Dictionary<string, object?> { ["status"] = "ok" };

    switch (action) {
      case "screenshot":
        result["data"] = Convert.ToBase64String(Screenshot());
        break;
      case "click": {
        WinApi.SetCursorPos(Int(command, "x"), Int(command, "y"));
        string button = Text(command, "button", "left");
        MouseButton(button, true); Thread.Sleep(30); MouseButton(button, false);
        break;
      }
      case "mouse_down":
        WinApi.SetCursorPos(Int(command, "x"), Int(command, "y"));
        MouseButton(Text(command, "button", "left"), true);
        break;
      case "mouse_up":
        WinApi.SetCursorPos(Int(command, "x"), Int(command, "y"));
        MouseButton(Text(command, "button", "left"), false);
        break;
      case "mouse_move":
        WinApi.SetCursorPos(Int(command, "x"), Int(command, "y"));
        break;
      case "drag": {
        int fromX = Int(command, "from_x"), fromY = Int(command, "from_y");
        int toX = Int(command, "to_x"), toY = Int(command, "to_y");
        WinApi.SetCursorPos(fromX, fromY); MouseButton("left", true);
        for (int i = 1; i <= 20; i++) {
          double progress = i / 20d;
          WinApi.SetCursorPos((int)(fromX + (toX - fromX) * progress), (int)(fromY + (toY - fromY) * progress));
          Thread.Sleep(8);
        }
        MouseButton("left", false);
        break;
      }
      case "scroll":
        WinApi.SetCursorPos(Int(command, "x"), Int(command, "y"));
        WinApi.mouse_event(WinApi.Wheel, 0, 0, unchecked((uint)(Int(command, "delta_y", -3) * 120)), 0);
        break;
      case "type":
        SendKeys.SendWait(Text(command, "text"));
        break;
      case "press_key": {
        string[] parts = Text(command, "key").ToLowerInvariant().Split('+');
        string sendKey = SendKeyName(parts[^1]);
        for (int i = 0; i < parts.Length - 1; i++) {
          sendKey = parts[i] switch { "ctrl" or "control" => "^" + sendKey, "alt" or "option" => "%" + sendKey, "shift" => "+" + sendKey, _ => sendKey };
        }
        SendKeys.SendWait(sendKey);
        break;
      }
      case "get_windows": {
        var windows = new List<Dictionary<string, object>>();
        IntPtr window = WinApi.GetWindow(WinApi.GetDesktopWindow(), 5);
        while (window != IntPtr.Zero) {
          int length = WinApi.GetWindowTextLength(window);
          if (WinApi.IsWindowVisible(window) && length > 0) {
            var title = new StringBuilder(length + 1);
            WinApi.GetWindowText(window, title, title.Capacity);
            WinApi.GetWindowRect(window, out var rect);
            WinApi.GetWindowThreadProcessId(window, out uint pid);
            try {
              windows.Add(new() {
                ["id"] = window.ToInt64(), ["title"] = title.ToString(), ["app"] = Process.GetProcessById((int)pid).ProcessName,
                ["x"] = rect.Left, ["y"] = rect.Top, ["width"] = rect.Right - rect.Left, ["height"] = rect.Bottom - rect.Top
              });
            } catch { }
          }
          window = WinApi.GetWindow(window, 2);
        }
        result["windows"] = windows;
        break;
      }
      case "focus_window": {
        IntPtr window = new(Int64.Parse(Text(command, "window_id", "0")));
        WinApi.ShowWindowAsync(window, WinApi.Restore);
        WinApi.SetForegroundWindow(window);
        break;
      }
      default:
        result["status"] = "error";
        result["error"] = $"Unknown action: {action}";
        break;
    }
    Console.WriteLine(JsonSerializer.Serialize(result));
  } catch (Exception error) {
    Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object> { ["status"] = "error", ["error"] = error.Message }));
  }
}
}
}
