using System.Text.Json;
using System.Text.Json.Serialization;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

record Request(int Version, Manifest Manifest, List<Source> Sources);
record Manifest(string Language, Selection Selection, Solution? Solution, List<Project> Projects);
record Selection(string Kind, string Path);
record Solution(string Path, List<string> Projects);
record Project(string Path, string? TargetFramework, string? LangVersion, List<string> References, List<string> Files);
record Source(string Path, string Staged);
record Response(int Version, List<ProjectResult> Projects, List<DiagnosticResult> Diagnostics);
record ProjectResult(string Path, int SourceCount, int SyntaxTreeCount, int DiagnosticCount);
record DiagnosticResult(string Project, string Code, string Severity, string? Path, int? Line, int? Column);

static class WindowsPath
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, System.Text.StringBuilder path, uint length, uint flags);

    public static string ReadVerified(FileStream stream, string root, string expectedPath)
    {
        var buffer = new System.Text.StringBuilder(32_768);
        var length = GetFinalPathNameByHandle(stream.SafeFileHandle, buffer, (uint)buffer.Capacity, 0);
        if (length is 0 or >= 32_768) throw new InvalidOperationException();
        var resolved = buffer.ToString();
        if (resolved.StartsWith("\\\\?\\", StringComparison.Ordinal)) resolved = resolved[4..];
        resolved = Path.GetFullPath(resolved);
        if (!resolved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !string.Equals(resolved, expectedPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        using var reader = new StreamReader(stream, new System.Text.UTF8Encoding(false, true), false, 4096, true);
        return reader.ReadToEnd();
    }
}

static class ProcessLimits
{
    private const uint JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitProcessMemory = 0x00000100;
    private const ulong MaxProcessMemoryBytes = 512UL * 1024 * 1024;
    private static SafeFileHandle? job;

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, uint informationClass, ref JobObjectExtendedLimitInformation information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    public static void Apply()
    {
        var created = CreateJobObject(IntPtr.Zero, null);
        if (created.IsInvalid) throw new InvalidOperationException();
        var information = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = JobObjectLimitProcessMemory },
            ProcessMemoryLimit = (UIntPtr)MaxProcessMemoryBytes,
        };
        if (!SetInformationJobObject(created, JobObjectExtendedLimitInformationClass, ref information, (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>()))
        {
            created.Dispose();
            throw new InvalidOperationException();
        }
        using var process = Process.GetCurrentProcess();
        if (!AssignProcessToJobObject(created, process.Handle))
        {
            created.Dispose();
            throw new InvalidOperationException();
        }
        job = created;
    }
}

internal static class Program
{
    static readonly HashSet<string> WindowsDeviceNames = new(StringComparer.OrdinalIgnoreCase)
{
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
};

    static bool Relative(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        !Path.IsPathRooted(value) &&
        !value.Contains('\\') &&
        !value.Contains(':') &&
        !value.Contains('\0') &&
        value.Split('/').All(x =>
            x.Length > 0 &&
            x != "." &&
            x != ".." &&
            !WindowsDeviceNames.Contains(x.TrimEnd(' ', '.').Split('.')[0]));

    static bool ContainedBy(string root, string candidate) =>
        candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    static string StagedName(int index) => $"source-{index:D6}.cs";

    static MetadataReference[] RuntimeReferences()
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location) ?? throw new InvalidOperationException();
        var runtimeRoot = Path.GetFullPath(runtimeDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var assemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? throw new InvalidOperationException();
        var references = new List<MetadataReference>();
        foreach (var assembly in assemblies.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).OrderBy(x => x, StringComparer.Ordinal))
        {
            var fullPath = Path.GetFullPath(assembly);
            if (!ContainedBy(runtimeRoot, fullPath)) continue;
            references.Add(MetadataReference.CreateFromFile(fullPath));
        }
        return references.Count > 0 ? references.ToArray() : throw new InvalidOperationException();
    }

    static CSharpParseOptions ParseOptions(string? languageVersion)
    {
        if (languageVersion is null) return CSharpParseOptions.Default;
        if (!LanguageVersionFacts.TryParse(languageVersion, out var parsed)) Invalid();
        return new CSharpParseOptions(parsed);
    }

    static void Invalid() => throw new InvalidOperationException();
    const int MaxFrameBytes = 2 * 1024 * 1024;
    const int MaxProjects = 256;
    const int MaxSolutionProjects = 256;
    const int MaxReferences = 256;
    const int MaxFiles = 10_000;
    const int MaxReadOperations = 16_384;
    const long MaxSourceBytes = 4L * 1024 * 1024;
    const long MaxAggregateBytes = 256L * 1024 * 1024;
    const int MaxDiagnostics = 4096;

    public static int Main()
    {
        try
        {
            if (!OperatingSystem.IsWindows()) Invalid();
            ProcessLimits.Apply();
            Console.OutputEncoding = new System.Text.UTF8Encoding(false, true);
            using var input = Console.OpenStandardInput();
            using var bytes = new MemoryStream();
            var buffer = new byte[8192];
            while (true)
            {
                var read = input.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                if (bytes.Length > MaxFrameBytes - read) Invalid();
                bytes.Write(buffer, 0, read);
            }
            if (bytes.Length is 0 or > MaxFrameBytes) Invalid();
            var line = new System.Text.UTF8Encoding(false, true).GetString(bytes.ToArray());
            if (!line.EndsWith('\n') || line[..^1].Contains('\n')) Invalid();
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = false, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
            var request = JsonSerializer.Deserialize<Request>(line, options) ?? throw new InvalidOperationException();
            var manifest = request.Manifest ?? throw new InvalidOperationException();
            var declaredProjects = manifest.Projects ?? throw new InvalidOperationException();
            var selection = manifest.Selection ?? throw new InvalidOperationException();
            var sources = request.Sources ?? throw new InvalidOperationException();
            if (request.Version != 1 || manifest.Language != "csharp" || selection.Kind is not ("solution" or "project") || !Relative(selection.Path) || declaredProjects.Count is 0 or > MaxProjects) Invalid();
            if (declaredProjects.Any(x => x.Files is null || x.References is null || !Relative(x.Path) || x.Files.Count > MaxFiles || x.References.Count > MaxReferences || x.Files.Distinct(StringComparer.Ordinal).Count() != x.Files.Count || x.References.Distinct(StringComparer.Ordinal).Count() != x.References.Count || x.Files.Any(file => !Relative(file)) || x.References.Any(reference => !Relative(reference)))) Invalid();
            var declared = declaredProjects.Select(x => x.Path).ToHashSet(StringComparer.Ordinal);
            if (declared.Count != declaredProjects.Count) Invalid();
            if (manifest.Solution is { } solution && (solution.Projects is null || !Relative(solution.Path) || solution.Projects.Count > MaxSolutionProjects || solution.Projects.Any(project => !Relative(project)) || solution.Projects.Distinct(StringComparer.Ordinal).Count() != solution.Projects.Count || !solution.Projects.SequenceEqual(declaredProjects.OrderBy(x => x.Path, StringComparer.Ordinal).Select(x => x.Path), StringComparer.Ordinal))) Invalid();
            if ((selection.Kind == "solution" && (manifest.Solution is null || manifest.Solution.Path != selection.Path)) || (selection.Kind == "project" && (manifest.Solution is not null || !declared.Contains(selection.Path)))) Invalid();
            if (declaredProjects.SelectMany(x => x.Files).Count() > MaxReadOperations || declaredProjects.Any(x => x.References.Any(reference => reference == x.Path || !declared.Contains(reference)))) Invalid();
            var logicalFiles = declaredProjects.SelectMany(x => x.Files).Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray();
            if (sources.Count != logicalFiles.Length || sources.Any(source => !Relative(source.Path)) || sources.Select(source => source.Path).Distinct(StringComparer.Ordinal).Count() != sources.Count || sources.Select(source => source.Staged).Distinct(StringComparer.Ordinal).Count() != sources.Count || !sources.OrderBy(source => source.Path, StringComparer.Ordinal).Select((source, index) => source.Path == logicalFiles[index] && source.Staged == StagedName(index)).All(valid => valid)) Invalid();
            var sourcePaths = sources.ToDictionary(source => source.Path, source => source.Staged, StringComparer.Ordinal);
            var projects = new List<ProjectResult>();
            var diagnostics = new List<DiagnosticResult>();
            long aggregateBytes = 0;
            var stagingRoot = Path.GetFullPath(Environment.CurrentDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            MetadataReference[] runtimeReferences = RuntimeReferences();
            var compilations = new Dictionary<string, CSharpCompilation>(StringComparer.Ordinal);
            var pending = declaredProjects.OrderBy(x => x.Path, StringComparer.Ordinal).ToList();
            while (pending.Count > 0)
            {
                var project = pending.FirstOrDefault(candidate => candidate.References is not null && candidate.References.All(compilations.ContainsKey)) ?? throw new InvalidOperationException();
                pending.Remove(project);
                var projectFiles = project.Files ?? throw new InvalidOperationException();
                var projectReferences = project.References ?? throw new InvalidOperationException();
                var parseOptions = ParseOptions(project.LangVersion);
                var trees = new List<SyntaxTree>();
                foreach (var file in projectFiles.OrderBy(x => x, StringComparer.Ordinal))
                {
                    var staged = sourcePaths[file];
                    var full = Path.Combine(stagingRoot, staged);
                    using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan);
                    if (stream.Length > MaxSourceBytes || stream.Length > MaxAggregateBytes - aggregateBytes) Invalid();
                    aggregateBytes += stream.Length;
                    trees.Add(CSharpSyntaxTree.ParseText(WindowsPath.ReadVerified(stream, stagingRoot, full), parseOptions, path: file));
                }
                var references = runtimeReferences.Concat(projectReferences.Select(reference => compilations[reference].ToMetadataReference()));
                var compilation = CSharpCompilation.Create(
                    project.Path,
                    trees,
                    references,
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                compilations.Add(project.Path, compilation);
                foreach (var tree in trees) _ = compilation.GetSemanticModel(tree);
                var diagnosticCount = 0;
                foreach (var diagnostic in compilation.GetDiagnostics())
                {
                    if (diagnostic.Severity is not (DiagnosticSeverity.Error or DiagnosticSeverity.Warning)) continue;
                    if (diagnostics.Count >= MaxDiagnostics) Invalid();
                    diagnosticCount++;
                    var span = diagnostic.Location.GetLineSpan();
                    var path = Relative(span.Path) ? span.Path : null;
                    diagnostics.Add(new(project.Path, diagnostic.Severity == DiagnosticSeverity.Warning ? "compiler_warning" : "compiler_error", diagnostic.Severity == DiagnosticSeverity.Warning ? "warning" : "error", path, path is null ? null : span.StartLinePosition.Line + 1, path is null ? null : span.StartLinePosition.Character + 1));
                }
                projects.Add(new(project.Path, trees.Count, trees.Count, diagnosticCount));
            }
            diagnostics = diagnostics.OrderBy(x => x.Project, StringComparer.Ordinal).ThenBy(x => x.Path, StringComparer.Ordinal).ThenBy(x => x.Line).ThenBy(x => x.Column).ThenBy(x => x.Code, StringComparer.Ordinal).ToList();
            projects = projects.OrderBy(x => x.Path, StringComparer.Ordinal).ToList();
            var output = new System.Text.UTF8Encoding(false, true).GetBytes(JsonSerializer.Serialize(new Response(1, projects, diagnostics), options));
            if (output.Length + 1 > MaxFrameBytes) Invalid();
            using var stdout = Console.OpenStandardOutput();
            stdout.Write(output, 0, output.Length);
            stdout.WriteByte((byte)'\n');
        }
        catch { return 1; }
        return 0;
    }
}
