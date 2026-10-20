using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class ContentLibraryLauncher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string projectRoot = AppDomain.CurrentDomain.BaseDirectory;
            string programRoot = Path.Combine(projectRoot, "程序文件");
            string scriptPath = Path.Combine(programRoot, "link-window.ps1");
            string powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            if (!File.Exists(powerShell))
                throw new FileNotFoundException("未找到 Windows PowerShell 5.1，请在 Windows 系统上运行此应用。");
            if (!File.Exists(scriptPath))
                throw new FileNotFoundException("缺少程序文件\\link-window.ps1，请检查项目文件是否完整。");
            if (!HasNodeOnPath())
                throw new FileNotFoundException("未找到 Node.js，请先安装 Node.js 后再启动多平台资料库。");
            if (!File.Exists(Path.Combine(programRoot, @"dist\link-cli.js")))
                throw new FileNotFoundException("缺少程序文件\\dist\\link-cli.js，请在程序文件目录运行 npm run build。");

            var start = new ProcessStartInfo
            {
                FileName = powerShell,
                Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File \"" + scriptPath + "\"",
                WorkingDirectory = programRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("无法创建多平台资料库窗口进程。");
            }
            return 0;
        }
        catch (Exception error)
        {
            Application.EnableVisualStyles();
            MessageBox.Show("无法启动多平台资料库：\n\n" + error.Message, "多平台资料库启动失败",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static bool HasNodeOnPath()
    {
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            string directory = entry.Trim().Trim('"');
            if (directory.Length == 0) continue;
            try
            {
                if (File.Exists(Path.Combine(directory, "node.exe"))) return true;
            }
            catch (ArgumentException) { }
        }
        return false;
    }
}
