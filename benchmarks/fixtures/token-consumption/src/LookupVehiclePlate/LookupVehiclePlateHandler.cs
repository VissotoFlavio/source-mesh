namespace SourceMesh.TokenFixture;

public sealed class LookupVehiclePlateHandler
{
    public VehiclePlateProjection SearchAsync(VehiclePlateEntity entity, CancellationToken cancellationToken)
        => ProjectAsync(entity, cancellationToken);

    public VehiclePlateProjection RetryAsync(VehiclePlateEntity entity, CancellationToken cancellationToken)
        => ProjectAsync(entity, cancellationToken);

    public VehiclePlateProjection PublishAuditAsync(VehiclePlateEntity entity, CancellationToken cancellationToken)
        => ProjectAsync(entity, cancellationToken);

    public VehiclePlateProjection ProjectBatchAsync(VehiclePlateEntity entity, CancellationToken cancellationToken)
        => ProjectAsync(entity, cancellationToken);

    private VehiclePlateProjection ProjectAsync(VehiclePlateEntity entity, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var normalizedPlate = PlateNormalizer.Normalize(entity.Plate);
        return VehiclePlateProjection.Map(entity) with { Plate = normalizedPlate };
    }
}

public sealed record VehiclePlateEntity(string Plate);
public sealed record VehiclePlateProjection(string Plate)
{
    public static VehiclePlateProjection Map(VehiclePlateEntity entity) => new(entity.Plate);
}

public static class PlateNormalizer
{
    public static string Normalize(string plate) => plate.Trim().ToUpperInvariant();
}
