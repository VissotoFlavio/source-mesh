using System.Text.Json;
using System.Text.Json.Serialization;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

record Request(int Version, Manifest Manifest, List<Source> Sources);
record Manifest(string Language, Selection Selection, Solution? Solution, List<Project> Projects);
record Selection(string Kind, string Path);
record Solution(string Path, List<string> Projects);
record Project(string Path, string? TargetFramework, string? LangVersion, List<string> References, List<string> Files);
record Source(string Path, string Staged);
record PositionResult(int Line, int Column);
record LocationResult(string Path, PositionResult Start, PositionResult End);
record SymbolResult(string Kind, string Path, string Name, string QualifiedName, string MemberRole);
record DeclarationResult(string Kind, string Path, string Name, string QualifiedName, string MemberRole, SymbolResult Parent, List<LocationResult> Locations);
record RelationshipResult(string Kind, string Status, SymbolResult Source, SymbolResult? Target, LocationResult? Location);
record Response(int Version, List<ProjectResult> Projects, List<DiagnosticResult> Diagnostics);
record ProjectResult(string Path, int SourceCount, int SyntaxTreeCount, int DiagnosticCount, List<DeclarationResult> Declarations, List<RelationshipResult> Relationships);
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

    sealed class ProjectAnalysis
    {
        public readonly Project Project;
        public readonly Dictionary<SyntaxTree, SemanticModel> Models;
        public readonly Dictionary<SyntaxNode, SymbolResult> Symbols = new();
        public readonly Dictionary<string, List<SymbolResult>> LocalSymbols = new(StringComparer.Ordinal);
        public readonly List<DeclarationResult> Declarations = new();
        public readonly List<RelationshipResult> Relationships = new();

        public ProjectAnalysis(Project project, Dictionary<SyntaxTree, SemanticModel> models)
        {
            Project = project;
            Models = models;
        }
    }

    static string Display(ISymbol symbol) =>
        symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat).Replace("global::", "", StringComparison.Ordinal);

    static string SymbolKey(ISymbol symbol)
    {
        if (symbol is IAliasSymbol alias) return SymbolKey(alias.Target);
        if (symbol is INamespaceSymbol namespaceSymbol)
            return $"namespace:{Display(namespaceSymbol)}";
        if (symbol is INamedTypeSymbol namedType)
            return $"type:{Display(namedType)}";
        if (symbol is IMethodSymbol method)
        {
            var container = method.ContainingSymbol is null ? "" : SymbolKey(method.ContainingSymbol);
            var parameters = string.Join(",", method.Parameters.Select(parameter => Display(parameter.Type)));
            return $"method:{container}.{method.Name}({parameters})";
        }
        if (symbol is IPropertySymbol property)
            return $"property:{SymbolKey(property.ContainingSymbol)}.{property.Name}";
        if (symbol is IFieldSymbol field)
            return $"field:{SymbolKey(field.ContainingSymbol)}.{field.Name}";
        if (symbol is IParameterSymbol parameter)
            return $"parameter:{SymbolKey(parameter.ContainingSymbol)}.{parameter.Name}";
        return $"symbol:{symbol.Kind}:{Display(symbol)}";
    }

    static SymbolResult Module(string path) => new("module", path, path, path, "none");

    static string JoinName(string prefix, string name) =>
        string.IsNullOrEmpty(prefix) ? name : $"{prefix}.{name}";

    static string LastName(string value)
    {
        var separator = value.LastIndexOf('.');
        return separator < 0 ? value : value[(separator + 1)..];
    }

    static LocationResult Location(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return new(
            span.Path,
            new(span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1),
            new(span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1));
    }

    static string MemberRole(ISymbol? symbol) => symbol?.IsStatic == true ? "static" : "instance";

    static void AddLocalSymbol(ProjectAnalysis analysis, ISymbol? symbol, SymbolResult result)
    {
        if (symbol is null) return;
        var key = SymbolKey(symbol);
        var values = analysis.LocalSymbols.TryGetValue(key, out var existing)
            ? existing
            : new List<SymbolResult>();
        if (!values.Contains(result)) values.Add(result);
        analysis.LocalSymbols[key] = values;
    }

    static void AddDeclaration(ProjectAnalysis analysis, SyntaxNode node, ISymbol? symbol, SymbolResult result, SymbolResult parent)
    {
        analysis.Symbols[node] = result;
        AddLocalSymbol(analysis, symbol, result);
        analysis.Declarations.Add(new(
            result.Kind,
            result.Path,
            result.Name,
            result.QualifiedName,
            result.MemberRole,
            parent,
            new List<LocationResult> { Location(node) }));
    }

    static void CollectFunctionBody(
        ProjectAnalysis analysis,
        SyntaxNode? body,
        SyntaxNode? expression,
        SymbolResult module,
        SymbolResult? namespaceSymbol,
        SymbolResult? typeSymbol,
        SymbolResult? functionSymbol)
    {
        if (body is not null)
            foreach (var child in body.ChildNodes())
                CollectNode(analysis, child, module, namespaceSymbol, typeSymbol, functionSymbol);
        if (expression is not null)
            CollectNode(analysis, expression, module, namespaceSymbol, typeSymbol, functionSymbol);
    }

    static void AddParameters(ProjectAnalysis analysis, SyntaxNode owner, ParameterListSyntax parameterList, SymbolResult function)
    {
        var model = analysis.Models[owner.SyntaxTree];
        foreach (var parameter in parameterList.Parameters)
        {
            if (parameter.Identifier.IsMissing) continue;
            var name = parameter.Identifier.ValueText;
            var result = new SymbolResult("parameter", owner.SyntaxTree.FilePath, name, JoinName(function.QualifiedName, name), "none");
            AddDeclaration(analysis, parameter, model.GetDeclaredSymbol(parameter), result, function);
        }
    }

    static void CollectNode(
        ProjectAnalysis analysis,
        SyntaxNode node,
        SymbolResult module,
        SymbolResult? namespaceSymbol,
        SymbolResult? typeSymbol,
        SymbolResult? functionSymbol)
    {
        var model = analysis.Models[node.SyntaxTree];
        if (node is BaseNamespaceDeclarationSyntax namespaceDeclaration)
        {
            var name = namespaceDeclaration.Name.ToString();
            if (string.IsNullOrEmpty(name))
            {
                foreach (var member in namespaceDeclaration.Members)
                    CollectNode(analysis, member, module, namespaceSymbol, null, null);
                return;
            }
            var qualifiedName = JoinName(namespaceSymbol?.QualifiedName ?? "", name);
            var result = new SymbolResult("namespace", node.SyntaxTree.FilePath, LastName(name), qualifiedName, "none");
            AddDeclaration(analysis, namespaceDeclaration, model.GetDeclaredSymbol(namespaceDeclaration), result, namespaceSymbol ?? module);
            foreach (var member in namespaceDeclaration.Members)
                CollectNode(analysis, member, module, result, null, null);
            return;
        }

        if (node is BaseTypeDeclarationSyntax typeDeclaration)
        {
            var name = typeDeclaration.Identifier.ValueText;
            if (string.IsNullOrEmpty(name))
            {
                if (typeDeclaration is TypeDeclarationSyntax malformedType)
                    foreach (var member in malformedType.Members)
                        CollectNode(analysis, member, module, namespaceSymbol, typeSymbol, functionSymbol);
                return;
            }
            var kind = typeDeclaration is ClassDeclarationSyntax ? "class"
                : typeDeclaration is InterfaceDeclarationSyntax ? "interface" : "type";
            var parent = typeSymbol ?? namespaceSymbol ?? module;
            var result = new SymbolResult(kind, node.SyntaxTree.FilePath, name, JoinName(parent.QualifiedName == module.QualifiedName ? "" : parent.QualifiedName, name), "none");
            AddDeclaration(analysis, typeDeclaration, model.GetDeclaredSymbol(typeDeclaration), result, parent);
            if (typeDeclaration is TypeDeclarationSyntax declaredType)
                foreach (var member in declaredType.Members)
                    CollectNode(analysis, member, module, namespaceSymbol, result, null);
            return;
        }

        if (node is MethodDeclarationSyntax method)
        {
            var parent = typeSymbol ?? functionSymbol ?? module;
            var name = method.Identifier.ValueText;
            if (string.IsNullOrEmpty(name))
            {
                CollectFunctionBody(analysis, method.Body, method.ExpressionBody?.Expression, module, namespaceSymbol, typeSymbol, functionSymbol);
                return;
            }
            var methodSymbol = model.GetDeclaredSymbol(method);
            var result = new SymbolResult("function", node.SyntaxTree.FilePath, name, JoinName(parent.QualifiedName == module.QualifiedName ? "" : parent.QualifiedName, name), MemberRole(methodSymbol));
            AddDeclaration(analysis, method, methodSymbol, result, parent);
            AddParameters(analysis, method, method.ParameterList, result);
            CollectFunctionBody(analysis, method.Body, method.ExpressionBody?.Expression, module, namespaceSymbol, typeSymbol, result);
            return;
        }

        if (node is LocalFunctionStatementSyntax localFunction)
        {
            var parent = functionSymbol ?? typeSymbol ?? module;
            var name = localFunction.Identifier.ValueText;
            if (string.IsNullOrEmpty(name))
            {
                CollectFunctionBody(analysis, localFunction.Body, null, module, namespaceSymbol, typeSymbol, functionSymbol);
                return;
            }
            var localSymbol = model.GetDeclaredSymbol(localFunction);
            var result = new SymbolResult("function", node.SyntaxTree.FilePath, name, JoinName(parent.QualifiedName == module.QualifiedName ? "" : parent.QualifiedName, name), MemberRole(localSymbol));
            AddDeclaration(analysis, localFunction, localSymbol, result, parent);
            AddParameters(analysis, localFunction, localFunction.ParameterList, result);
            CollectFunctionBody(analysis, localFunction.Body, null, module, namespaceSymbol, typeSymbol, result);
            return;
        }

        if (node is ConstructorDeclarationSyntax || node is AccessorDeclarationSyntax)
            return;

        if (node is PropertyDeclarationSyntax property)
        {
            var parent = typeSymbol ?? module;
            var name = property.Identifier.ValueText;
            if (string.IsNullOrEmpty(name)) return;
            var propertySymbol = model.GetDeclaredSymbol(property);
            var result = new SymbolResult("variable", node.SyntaxTree.FilePath, name, JoinName(parent.QualifiedName == module.QualifiedName ? "" : parent.QualifiedName, name), MemberRole(propertySymbol));
            AddDeclaration(analysis, property, propertySymbol, result, parent);
            return;
        }

        if (node is FieldDeclarationSyntax field)
        {
            var parent = typeSymbol ?? module;
            foreach (var variable in field.Declaration.Variables)
            {
                var name = variable.Identifier.ValueText;
                if (string.IsNullOrEmpty(name)) continue;
                var fieldSymbol = model.GetDeclaredSymbol(variable);
                var result = new SymbolResult("variable", node.SyntaxTree.FilePath, name, JoinName(parent.QualifiedName == module.QualifiedName ? "" : parent.QualifiedName, name), MemberRole(fieldSymbol));
                AddDeclaration(analysis, variable, fieldSymbol, result, parent);
            }
            return;
        }

        if (node is EventFieldDeclarationSyntax eventField)
        {
            var parent = typeSymbol ?? module;
            foreach (var variable in eventField.Declaration.Variables)
            {
                var name = variable.Identifier.ValueText;
                if (string.IsNullOrEmpty(name)) continue;
                var fieldSymbol = model.GetDeclaredSymbol(variable);
                var result = new SymbolResult("variable", node.SyntaxTree.FilePath, name, JoinName(parent.QualifiedName == module.QualifiedName ? "" : parent.QualifiedName, name), MemberRole(fieldSymbol));
                AddDeclaration(analysis, variable, fieldSymbol, result, parent);
            }
            return;
        }

        foreach (var child in node.ChildNodes())
            CollectNode(analysis, child, module, namespaceSymbol, typeSymbol, functionSymbol);
    }

    static void CollectDeclarations(ProjectAnalysis analysis)
    {
        foreach (var tree in analysis.Models.Keys.OrderBy(item => item.FilePath, StringComparer.Ordinal))
        {
            var module = Module(tree.FilePath);
            foreach (var member in ((CompilationUnitSyntax)tree.GetRoot()).Members)
                CollectNode(analysis, member, module, null, null, null);
        }
    }

    static SymbolResult? FindFunction(ProjectAnalysis analysis, SyntaxNode node)
    {
        for (SyntaxNode? current = node; current is not null; current = current.Parent)
            if (analysis.Symbols.TryGetValue(current, out var result) && result.Kind == "function")
                return result;
        return null;
    }

    static (string Status, SymbolResult? Target) Resolve(
        Dictionary<string, List<SymbolResult>> allSymbols,
        SymbolInfo info)
    {
        var symbols = info.CandidateSymbols.Length > 0
            ? info.CandidateSymbols.Cast<ISymbol>().ToArray()
            : info.Symbol is null ? Array.Empty<ISymbol>() : new[] { info.Symbol };
        if (symbols.Length == 0) return ("unresolved", null);
        if (symbols.Length > 1) return ("ambiguous", null);
        var key = SymbolKey(symbols[0]);
        if (!allSymbols.TryGetValue(key, out var local)) return ("external", null);
        var candidates = local.Distinct().ToList();
        return candidates.Count == 1 ? ("resolved", candidates[0]) : ("ambiguous", null);
    }

    static void Relationship(
        ProjectAnalysis analysis,
        string kind,
        string status,
        SymbolResult source,
        SymbolResult? target,
        SyntaxNode node)
    {
        analysis.Relationships.Add(new(kind, status, source, target, Location(node)));
    }

    static void ResolvedRelationship(
        ProjectAnalysis analysis,
        Dictionary<string, List<SymbolResult>> allSymbols,
        string kind,
        SymbolResult source,
        SymbolInfo info,
        SyntaxNode node,
        Func<SymbolResult, bool> targetIsAllowed)
    {
        var resolved = Resolve(allSymbols, info);
        if (resolved.Status != "resolved")
        {
            Relationship(analysis, kind, resolved.Status, source, null, node);
            return;
        }
        if (!targetIsAllowed(resolved.Target!))
        {
            Relationship(analysis, kind, "unsupported", source, null, node);
            return;
        }
        Relationship(analysis, kind, "resolved", source, resolved.Target, node);
    }

    static void CollectRelationships(
        ProjectAnalysis analysis,
        Dictionary<string, List<SymbolResult>> allSymbols)
    {
        foreach (var tree in analysis.Models.Keys.OrderBy(item => item.FilePath, StringComparer.Ordinal))
        {
            var model = analysis.Models[tree];
            var module = Module(tree.FilePath);
            void Visit(SyntaxNode node)
            {
                if (node is UsingDirectiveSyntax usingDirective)
                {
                    if (usingDirective.Alias is not null || usingDirective.GlobalKeyword.RawKind != 0 || usingDirective.StaticKeyword.RawKind != 0)
                        Relationship(analysis, "uses", "unsupported", module, null, node);
                    else
                        ResolvedRelationship(analysis, allSymbols, "uses", module, model.GetSymbolInfo(usingDirective.Name!), node, target => target.Kind == "namespace");
                }
                else if (node is ExternAliasDirectiveSyntax)
                    Relationship(analysis, "uses", "unsupported", module, null, node);

                if (node is BaseTypeDeclarationSyntax typeDeclaration && analysis.Symbols.TryGetValue(node, out var owner))
                {
                    if (typeDeclaration.BaseList is not null && owner.Kind is "class" or "interface")
                        foreach (var baseType in typeDeclaration.BaseList.Types)
                        {
                            var symbol = model.GetTypeInfo(baseType.Type).Type;
                            var info = model.GetSymbolInfo(baseType.Type);
                            var relationKind = owner.Kind == "interface"
                                ? "extends"
                                : symbol is INamedTypeSymbol { TypeKind: TypeKind.Interface } ? "implements" : "extends";
                            ResolvedRelationship(
                                analysis,
                                allSymbols,
                                relationKind,
                                owner,
                                info,
                                baseType,
                                target => relationKind == "implements" ? target.Kind == "interface" : target.Kind is "class" or "interface");
                        }
                }

                if (node is InvocationExpressionSyntax invocation)
                {
                    var source = FindFunction(analysis, node) ?? module;
                    var info = model.GetSymbolInfo(invocation);
                    var type = model.GetTypeInfo(invocation.Expression).Type;
                    if (type is IDynamicTypeSymbol)
                        Relationship(analysis, "calls", "dynamic", source, null, node);
                    else if (info.Symbol is IMethodSymbol method && method.MethodKind is MethodKind.Constructor or MethodKind.PropertyGet or MethodKind.PropertySet)
                        Relationship(analysis, "calls", "unsupported", source, null, node);
                    else
                        ResolvedRelationship(analysis, allSymbols, "calls", source, info, node, target => target.Kind == "function");
                }
                else if (node is ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax)
                {
                    var source = FindFunction(analysis, node) ?? module;
                    Relationship(analysis, "calls", "unsupported", source, null, node);
                }

                foreach (var child in node.ChildNodes()) Visit(child);
            }
            Visit(tree.GetRoot());
        }
    }

    static int CompareLocation(LocationResult left, LocationResult right) =>
        string.CompareOrdinal(left.Path, right.Path) != 0
            ? string.CompareOrdinal(left.Path, right.Path)
            : left.Start.Line != right.Start.Line
                ? left.Start.Line - right.Start.Line
                : left.Start.Column != right.Start.Column
                    ? left.Start.Column - right.Start.Column
                    : left.End.Line != right.End.Line
                        ? left.End.Line - right.End.Line
                        : left.End.Column - right.End.Column;

    static int CompareSymbol(SymbolResult left, SymbolResult right) =>
        string.CompareOrdinal(left.Path, right.Path) != 0
            ? string.CompareOrdinal(left.Path, right.Path)
            : string.CompareOrdinal(left.QualifiedName, right.QualifiedName) != 0
                ? string.CompareOrdinal(left.QualifiedName, right.QualifiedName)
                : string.CompareOrdinal(left.Kind, right.Kind) != 0
                    ? string.CompareOrdinal(left.Kind, right.Kind)
                    : string.CompareOrdinal(left.MemberRole, right.MemberRole) != 0
                        ? string.CompareOrdinal(left.MemberRole, right.MemberRole)
                        : string.CompareOrdinal(left.Name, right.Name);

    static int CompareDeclaration(DeclarationResult left, DeclarationResult right) =>
        CompareSymbol(new(left.Kind, left.Path, left.Name, left.QualifiedName, left.MemberRole), new(right.Kind, right.Path, right.Name, right.QualifiedName, right.MemberRole)) != 0
            ? CompareSymbol(new(left.Kind, left.Path, left.Name, left.QualifiedName, left.MemberRole), new(right.Kind, right.Path, right.Name, right.QualifiedName, right.MemberRole))
            : CompareSymbol(left.Parent, right.Parent) != 0
                ? CompareSymbol(left.Parent, right.Parent)
                : CompareLocation(left.Locations[0], right.Locations[0]);

    static int CompareRelationship(RelationshipResult left, RelationshipResult right) =>
        string.CompareOrdinal(left.Kind, right.Kind) != 0
            ? string.CompareOrdinal(left.Kind, right.Kind)
            : string.CompareOrdinal(left.Status, right.Status) != 0
                ? string.CompareOrdinal(left.Status, right.Status)
                : CompareSymbol(left.Source, right.Source) != 0
                    ? CompareSymbol(left.Source, right.Source)
                    : CompareSymbol(left.Target ?? left.Source, right.Target ?? right.Source) != 0
                        ? CompareSymbol(left.Target ?? left.Source, right.Target ?? right.Source)
                        : CompareLocation(left.Location ?? new("", new(0, 0), new(0, 0)), right.Location ?? new("", new(0, 0), new(0, 0)));

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
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = false, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
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
            if (declaredProjects.SelectMany(x => x.Files).Count() > MaxReadOperations || declaredProjects.Any(x => x.References.Any(reference => reference == x.Path))) Invalid();
            var logicalFiles = declaredProjects.SelectMany(x => x.Files).Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray();
            if (sources.Count != logicalFiles.Length || sources.Any(source => !Relative(source.Path)) || sources.Select(source => source.Path).Distinct(StringComparer.Ordinal).Count() != sources.Count || sources.Select(source => source.Staged).Distinct(StringComparer.Ordinal).Count() != sources.Count || !sources.OrderBy(source => source.Path, StringComparer.Ordinal).Select((source, index) => source.Path == logicalFiles[index] && source.Staged == StagedName(index)).All(valid => valid)) Invalid();
            var sourcePaths = sources.ToDictionary(source => source.Path, source => source.Staged, StringComparer.Ordinal);
            var projects = new List<ProjectResult>();
            var diagnostics = new List<DiagnosticResult>();
            long aggregateBytes = 0;
            var stagingRoot = Path.GetFullPath(Environment.CurrentDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            MetadataReference[] runtimeReferences = RuntimeReferences();
            var compilations = new Dictionary<string, CSharpCompilation>(StringComparer.Ordinal);
            var analyses = new List<ProjectAnalysis>();
            var pending = declaredProjects.OrderBy(x => x.Path, StringComparer.Ordinal).ToList();
            while (pending.Count > 0)
            {
                var project = pending.FirstOrDefault(candidate => candidate.References is not null && candidate.References.All(reference => !declared.Contains(reference) || compilations.ContainsKey(reference))) ?? throw new InvalidOperationException();
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
                var references = runtimeReferences.Concat(projectReferences.Where(compilations.ContainsKey).Select(reference => compilations[reference].ToMetadataReference()));
                var compilation = CSharpCompilation.Create(
                    project.Path,
                    trees,
                    references,
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                compilations.Add(project.Path, compilation);
                var models = trees.ToDictionary(tree => tree, tree => compilation.GetSemanticModel(tree));
                var analysis = new ProjectAnalysis(project, models);
                CollectDeclarations(analysis);
                analyses.Add(analysis);
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
            }
            var allSymbols = new Dictionary<string, List<SymbolResult>>(StringComparer.Ordinal);
            foreach (var analysis in analyses)
                foreach (var (key, values) in analysis.LocalSymbols)
                {
                    var existing = allSymbols.TryGetValue(key, out var current) ? current : new List<SymbolResult>();
                    foreach (var value in values)
                        if (!existing.Contains(value)) existing.Add(value);
                    allSymbols[key] = existing;
                }
            foreach (var analysis in analyses)
            {
                CollectRelationships(analysis, allSymbols);
                var declarations = analysis.Declarations
                    .OrderBy(item => item, Comparer<DeclarationResult>.Create(CompareDeclaration))
                    .ToList();
                var relationships = analysis.Relationships
                    .OrderBy(item => item, Comparer<RelationshipResult>.Create(CompareRelationship))
                    .ToList();
                var trees = analysis.Models.Keys.Count;
                var diagnosticCount = diagnostics.Count(item => item.Project == analysis.Project.Path);
                projects.Add(new(analysis.Project.Path, trees, trees, diagnosticCount, declarations, relationships));
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
