module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn("patients", "whatsapp_phone", {
      type: DataTypes.STRING(30), allowNull: true
    });
    await queryInterface.addColumn("patients", "whatsapp_consent_at", {
      type: DataTypes.DATE(3), allowNull: true
    });
    await queryInterface.addColumn("patients", "whatsapp_verified_at", {
      type: DataTypes.DATE(3), allowNull: true
    });
    await queryInterface.addColumn("patients", "whatsapp_verification_code_hash", {
      type: DataTypes.CHAR(64), allowNull: true
    });
    await queryInterface.addColumn("patients", "whatsapp_verification_expires_at", {
      type: DataTypes.DATE(3), allowNull: true
    });
    await queryInterface.addColumn("patients", "whatsapp_verification_attempts", {
      type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0
    });
    await queryInterface.addIndex("patients", ["whatsapp_phone"], {
      unique: true, name: "patients_whatsapp_phone_unique"
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("patients", "patients_whatsapp_phone_unique");
    await queryInterface.removeColumn("patients", "whatsapp_verification_attempts");
    await queryInterface.removeColumn("patients", "whatsapp_verification_expires_at");
    await queryInterface.removeColumn("patients", "whatsapp_verification_code_hash");
    await queryInterface.removeColumn("patients", "whatsapp_verified_at");
    await queryInterface.removeColumn("patients", "whatsapp_consent_at");
    await queryInterface.removeColumn("patients", "whatsapp_phone");
  }
};
